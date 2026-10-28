// 独立公开启动链回归：使用合成 Git 配置、密钥、凭据和 loopback 远端，不接触桌面服务。
// 运行：node scripts/git-auth-smoke.mjs；可用 AREAL_TEST_BIN_DIR 指向已构建的完整 bin 目录。
// 需要已有 ws 开发依赖、Git（支持 SSH 签名）、OpenSSH、OpenSSL，以及允许本地监听的环境。
// macOS 默认使用 /tmp 避免登录会话的长临时路径；可显式设置 AREAL_GIT_AUTH_TMPDIR。
// 需要该目录的写权限；目录不可用或过长就失败，不另选路径绕过限制。
// AREAL_GIT_AUTH_EVIDENCE_DIR 可保存经密码扫描的模型请求、结果、诊断和最终报告。
// 显式 --keychain 仅用于已获准的 macOS 登录会话：临时写入随机测试条目并删除。
// 该模式必须指定证据目录，以便中断后按无密码的精确条目记录清理；不进入默认 CI。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { CoreClient } from "../clients/gui/packages/runtime-client/core.js";
import { respondToSessionName } from "./model-fixture.mjs";

process.umask(0o077);
const bin = resolve(process.env.AREAL_TEST_BIN_DIR ?? "target/debug", "areal");
const evidence = process.env.AREAL_GIT_AUTH_EVIDENCE_DIR
  ? resolve(process.env.AREAL_GIT_AUTH_EVIDENCE_DIR)
  : null;
const password = randomBytes(24).toString("hex");
const wrongPassword = randomBytes(24).toString("hex");
const keychainMode = process.argv.slice(2).includes("--keychain");
const username = `areal-git-fixture-${randomUUID()}`;
const secrets = [password, wrongPassword].flatMap((value) => [
  value,
  Buffer.from(value).toString("base64"),
  Buffer.from(`${username}:${value}`).toString("base64"),
  encodeURIComponent(value),
]);
const children = new Set();
const servers = [];
const checks = [];
const modelRequests = [];
const modelResponses = [];
const histories = [];
const diagnostics = [];
const scenarios = new Map();
const authentication = { challenged: 0, rejected: 0, accepted: 0, receivePack: 0 };
const cleanup = { services: [], errors: [], temporaryFilesRemoved: false };
const keychain = {
  enabled: keychainMode,
  correctCredentialVerified: false,
  wrongCredentialVerified: false,
  cleanupConfirmed: false,
  settingsUnchanged: false,
};
let keychainHelper, keychainQuery, keychainSettings, keychainRecovery;
let keychainMayExist = false;
let root, workspace, home, data, registry, config, env, service, client, socket, agent;
let modelFailure, serverFailure, failure;
let phase = "preflight";
let passed = false;
let serviceAttempted = false;
let gitConfig, localConfig;
let cleaningUp = false;
const interruption = new AbortController();
const interrupt = (signal) => interruption.abort(Error(`Interrupted by ${signal}`));
if (keychainMode) {
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
}
function checkInterruption() {
  if (!cleaningUp && interruption.signal.aborted) throw interruption.signal.reason;
}
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function noSecret(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert(!secrets.some((secret) => text.includes(secret)), `synthetic password leaked: ${label}`);
}
function safeError(error) {
  let message = String(error?.message ?? error);
  for (const secret of secrets) message = message.replaceAll(secret, "[redacted]");
  return message.slice(0, 3000);
}
async function bounded(promise, ms, label, cleanupWait = false) {
  let timer, onAbort;
  try {
    const waiting = [
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ];
    if (!cleaningUp && !cleanupWait) {
      waiting.push(
        new Promise((_, reject) => {
          onAbort = () => reject(interruption.signal.reason);
          if (interruption.signal.aborted) onAbort();
          else interruption.signal.addEventListener("abort", onAbort, { once: true });
        }),
      );
    }
    return await Promise.race(waiting);
  } finally {
    clearTimeout(timer);
    if (onAbort) interruption.signal.removeEventListener("abort", onAbort);
  }
}
async function until(test, ms, label) {
  const end = Date.now() + ms;
  do {
    checkInterruption();
    if (await test()) return;
    await delay(50);
  } while (Date.now() < end);
  throw Error(`${label} timed out`);
}
function launch(command, args, options = {}) {
  checkInterruption();
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
  const entry = { child, stdout: [], stderr: [], bytes: 0, overflow: false };
  children.add(entry);
  entry.closed = new Promise((resolve) => {
    child.once("error", (error) => {
      entry.error = error;
    });
    child.once("close", (code, signal) => {
      entry.result = { code, signal };
      children.delete(entry);
      resolve(entry.result);
    });
  });
  for (const name of ["stdout", "stderr"])
    child[name].on("data", (chunk) => {
      entry.bytes += chunk.length;
      if (entry.bytes > 8 * 1024 * 1024) {
        entry.overflow = true;
        child.kill("SIGKILL");
      } else entry[name].push(chunk);
    });
  // git http-backend 拒绝请求时可能提前关闭 stdin；由真实退出码判断，不制造未处理异常。
  child.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") entry.error = error;
  });
  return entry;
}
async function terminate(entry) {
  if (!entry || entry.result) return;
  entry.child.kill("SIGTERM");
  try {
    await bounded(entry.closed, 3000, "child SIGTERM", true);
  } catch {
    entry.child.kill("SIGKILL");
    await bounded(entry.closed, 3000, "child SIGKILL", true);
  }
}
async function run(command, args, { timeout = 20000, input = "", ...options } = {}) {
  const entry = launch(command, args, options);
  entry.child.stdin.end(input);
  try {
    await bounded(entry.closed, timeout, command);
    if (entry.error) throw entry.error;
    assert(!entry.overflow, `${command}: output limit exceeded`);
    const stdoutBytes = Buffer.concat(entry.stdout);
    const result = {
      ...entry.result,
      stdout: stdoutBytes.toString("utf8"),
      stderr: Buffer.concat(entry.stderr).toString("utf8"),
    };
    diagnostics.push({ command, ...result });
    noSecret(result, "child output");
    assert.equal(result.code, 0, `${command} failed (${result.code}): ${result.stderr}`);
    return { ...result, stdoutBytes };
  } finally {
    await terminate(entry);
  }
}
// credential 协议的 stdout 可能含密码，只在此处比对已知合成值，绝不送进通用日志。
async function keychainOperation(operation, expectedPassword = null) {
  assert(["get", "store", "erase"].includes(operation));
  const entry = launch(keychainHelper, [operation]);
  const fields = operation === "store" ? `password=${expectedPassword}\n` : "";
  entry.child.stdin.end(`${keychainQuery}${fields}\n`);
  try {
    await bounded(entry.closed, 15000, `Keychain ${operation}`);
    if (entry.error) throw entry.error;
    assert(!entry.overflow, "Keychain output limit exceeded");
    const stderr = Buffer.concat(entry.stderr).toString("utf8");
    noSecret(stderr, "Keychain stderr");
    assert.equal(entry.result.code, 0, `Keychain ${operation} failed: ${safeError(stderr)}`);
    const text = Buffer.concat(entry.stdout).toString("utf8");
    if (operation === "get" && expectedPassword !== null) {
      const fields = new Map(
        text
          .trim()
          .split("\n")
          .map((line) => {
            const split = line.indexOf("=");
            return [line.slice(0, split), line.slice(split + 1)];
          }),
      );
      // Git helper 可只返回缺失字段；输入已精确指定账户，不要求再次回显。
      assert(
        !fields.has("username") || fields.get("username") === username,
        "Keychain returned an unexpected account",
      );
      assert(fields.get("password") === expectedPassword, "Keychain test password did not match");
    } else {
      assert(!text.trim(), "Keychain returned unexpected credential output; contents withheld");
    }
    diagnostics.push({ command: keychainHelper, operation, exitCode: entry.result.code });
  } finally {
    await terminate(entry);
  }
}
async function readKeychainSettings() {
  const commands = [
    ["default-keychain", "-d", "user"],
    ["list-keychains", "-d", "user"],
  ];
  return Promise.all(commands.map(async (args) => (await run("/usr/bin/security", args)).stdout));
}
async function recordKeychainRecovery() {
  const record = {
    helper: keychainHelper,
    query: keychainQuery,
    storedVerified: keychain.correctCredentialVerified,
    service: service ? { id: service.serviceId, generation: service.generation, registry } : null,
    cleanupConfirmed: keychain.cleanupConfirmed,
  };
  // 更新过程不能截断唯一恢复记录；强制终止时旧版仍保留精确条目。
  const next = `${keychainRecovery}.next`;
  await writeFile(next, JSON.stringify(record, null, 2), { mode: 0o600, flush: true });
  await rename(next, keychainRecovery);
}
async function initializeKeychain(remote) {
  keychainHelper = join(
    (await run("/usr/bin/git", ["--exec-path"])).stdout.trim(),
    "git-credential-osxkeychain",
  );
  await access(keychainHelper, constants.X_OK);
  keychainSettings = await readKeychainSettings();
  keychainQuery = `protocol=https\nhost=127.0.0.1:${remote.port}\npath=remote.git\nusername=${username}\n`;
  // 先确认精确随机条目不存在；若意外匹配，不覆盖，也不删除。
  await keychainOperation("get");
  await mkdir(evidence, { recursive: true });
  keychainRecovery = join(evidence, `${username}-keychain-cleanup.json`);
  await writeFile(
    keychainRecovery,
    JSON.stringify(
      {
        helper: keychainHelper,
        query: keychainQuery,
        cleanupConfirmed: false,
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600, flush: true },
  );
  // store 即使超时也可能已生效；finally 只清理此前确认不存在的精确条目。
  keychainMayExist = true;
  await keychainOperation("store", password);
  await keychainOperation("get", password);
  keychain.correctCredentialVerified = true;
  await recordKeychainRecovery();
}
const git = (args, cwd = workspace) => run("git", args, { cwd });
async function cli(args, timeout = 60000) {
  // 与现有 smoke 一致：macOS 用系统父进程启动 Mach-O，不换成桌面已安装的服务。
  const argv =
    process.platform === "darwin"
      ? [
          "/usr/bin/python3",
          "-I",
          "-S",
          "-c",
          "import signal,subprocess,sys; p=subprocess.Popen(sys.argv[1:]); signal.signal(signal.SIGTERM,lambda *_:p.terminate()); signal.signal(signal.SIGINT,lambda *_:p.send_signal(signal.SIGINT)); r=p.wait(); sys.exit(r if r>=0 else 128-r)",
          bin,
          ...args,
        ]
      : [bin, ...args];
  return JSON.parse((await run(argv[0], argv.slice(1), { timeout })).stdout);
}
async function listen(server) {
  servers.push(server);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.setTimeout(20000, (connection) => connection.destroy());
  await bounded(
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }),
    5000,
    "loopback listener",
  );
  return server.address().port;
}
async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    assert(size <= 4 * 1024 * 1024, "fixture request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function sse(response, delta, finish) {
  const packet = `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  noSecret(packet, "model response");
  modelResponses.push(packet);
  response.write(packet);
}
function modelFixture() {
  return httpServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      const raw = (await body(request)).toString("utf8");
      noSecret(raw, "model request/tool result");
      modelRequests.push(JSON.parse(raw));
      const value = modelRequests.at(-1);
      if (respondToSessionName(value, response)) return;
      const index = value.messages.findLastIndex(
        (message) =>
          message.role === "user" &&
          !(
            typeof message.content === "string" &&
            message.content.startsWith("AReaL runtime context (not a user request):")
          ),
      );
      const content = value.messages[index]?.content;
      const text =
        typeof content === "string" ? content : content?.map((part) => part.text ?? "").join("");
      const scenario = scenarios.get(text);
      assert(scenario, "unexpected model prompt");
      assert(value.tools.some((tool) => tool.function?.name === "run_command"));
      const results = value.messages.slice(index + 1).filter((message) => message.role === "tool");
      scenario.rounds++;
      assert.equal(scenario.rounds, results.length + 1, "fixture must not replay a command");
      assert(scenario.rounds <= 2, "one run_command per scenario");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (!results.length) {
        sse(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: `git-${scenario.name}`,
                type: "function",
                function: { name: "run_command", arguments: JSON.stringify(scenario.args) },
              },
            ],
          },
          "tool_calls",
        );
      } else {
        scenario.result = JSON.parse(results[0].content);
        sse(response, { content: "Git fixture complete" }, "stop");
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      modelFailure ??= safeError(error);
      if (!response.headersSent) response.writeHead(500);
      response.end("Deterministic fixture assertion failed");
    }
  });
}
async function httpsFixture() {
  const ca = join(root, "ca.pem");
  const key = join(root, "https.key");
  const cert = join(root, "https.pem");
  const opensslConfig = join(root, "openssl.cnf");
  await writeFile(
    opensslConfig,
    `[req]
distinguished_name=dn
[dn]
[ca_ext]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
[server_ext]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1
`,
  );
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=Git Fixture CA",
    "-config",
    opensslConfig,
    "-extensions",
    "ca_ext",
    "-keyout",
    join(root, "ca.key"),
    "-out",
    ca,
  ]);
  await run("openssl", [
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=127.0.0.1",
    "-config",
    opensslConfig,
    "-keyout",
    key,
    "-out",
    join(root, "https.csr"),
  ]);
  await run("openssl", [
    "x509",
    "-req",
    "-in",
    join(root, "https.csr"),
    "-CA",
    ca,
    "-CAkey",
    join(root, "ca.key"),
    "-set_serial",
    "1",
    "-days",
    "1",
    "-extfile",
    opensslConfig,
    "-extensions",
    "server_ext",
    "-out",
    cert,
  ]);
  await run("openssl", ["verify", "-CAfile", ca, cert]);
  const remotes = join(root, "remotes");
  await mkdir(remotes);
  await git(["init", "--bare", "--initial-branch=main", join(remotes, "remote.git")], root);
  await git(["config", "http.receivepack", "true"], join(remotes, "remote.git"));
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const server = httpsServer(
    { key: await readFile(key), cert: await readFile(cert) },
    async (request, response) => {
      try {
        const url = new URL(request.url, "https://127.0.0.1");
        const discovery =
          request.method === "GET" &&
          url.pathname === "/remote.git/info/refs" &&
          url.search === "?service=git-receive-pack";
        const push =
          request.method === "POST" &&
          url.pathname === "/remote.git/git-receive-pack" &&
          !url.search;
        if (!discovery && !push) {
          request.resume();
          response.writeHead(404).end();
          return;
        }
        if (request.headers.authorization !== expected) {
          if (request.headers.authorization) authentication.rejected++;
          else authentication.challenged++;
          request.resume();
          response
            .writeHead(401, { "WWW-Authenticate": 'Basic realm="git-fixture"' })
            .end("Authentication required");
          return;
        }
        authentication.accepted++;
        if (push) authentication.receivePack++;
        const input = await body(request);
        const result = await run("git", ["http-backend"], {
          input,
          cwd: remotes,
          timeout: 15000,
          env: {
            ...env,
            GIT_PROJECT_ROOT: remotes,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: request.method,
            CONTENT_TYPE: request.headers["content-type"] ?? "",
            CONTENT_LENGTH: String(input.length),
            SERVER_PROTOCOL: "HTTP/1.1",
            REMOTE_USER: username,
            REMOTE_ADDR: "127.0.0.1",
          },
        });
        // CGI 头与 pack 响应分开传递；响应体为 Git 协议字节，不能做 JSON 或模拟成功处理。
        const bytes = result.stdoutBytes;
        const split = bytes.indexOf("\r\n\r\n");
        assert(split >= 0, "git http-backend omitted CGI headers");
        const headers = {};
        let statusCode = 200;
        for (const line of bytes.subarray(0, split).toString("ascii").split("\r\n")) {
          const colon = line.indexOf(":");
          assert(colon > 0, "invalid CGI header");
          const name = line.slice(0, colon).toLowerCase();
          const value = line.slice(colon + 1).trim();
          if (name === "status") statusCode = Number(value.split(" ")[0]);
          else headers[name] = value;
        }
        response.writeHead(statusCode, headers);
        response.end(bytes.subarray(split + 4));
      } catch (error) {
        serverFailure ??= safeError(error);
        if (!response.headersSent) response.writeHead(500);
        response.end("Git fixture failed");
      }
    },
  );
  const port = await listen(server);
  return {
    ca,
    port,
    bare: join(remotes, "remote.git"),
    url: `https://127.0.0.1:${port}/remote.git`,
  };
}
async function configurationUnchanged() {
  assert.equal(
    await readFile(join(home, ".gitconfig"), "utf8"),
    gitConfig,
    "global Git config mutated",
  );
  assert.equal(
    await readFile(join(workspace, ".git/config"), "utf8"),
    localConfig,
    "repository config mutated",
  );
}
async function scenario(name, script, success = true, stderrPattern) {
  phase = name;
  const prompt = `git-auth:${name}`;
  // 不注入 user.name/email、HOME 或 SSH_AUTH_SOCK：必须验证产品启动链的配置及 agent 继承。
  // Keychain 依赖登录 HOME，但 Git 配置仍只读合成文件，不读取用户的全局 Git 配置。
  const isolatedGit = keychainMode
    ? `export GIT_CONFIG_GLOBAL=${quote(join(home, ".gitconfig"))}\n`
    : "";
  const prefix = `set -eu
export GIT_CONFIG_NOSYSTEM=1 GIT_ATTR_NOSYSTEM=1
export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false SSH_ASKPASS=/bin/false
${isolatedGit}test "$HOME" = ${quote(env.HOME)}
`;
  const spec = {
    name,
    rounds: 0,
    args: {
      argv: ["/bin/sh", "-c", prefix + script],
      cwd: ".",
      timeoutMs: 20000,
      yieldMs: 30000,
      stdinOpen: false,
    },
  };
  scenarios.set(prompt, spec);
  const { thread } = await client.request("areal/thread/start", {
    requestId: randomUUID(),
    cwd: workspace,
    options: { permissionPreset: "fullAccess" },
  });
  const { turn } = await client.request("areal/turn/start", {
    requestId: randomUUID(),
    threadId: thread.id,
    input: [{ type: "text", text: prompt }],
  });
  let snapshot;
  await until(
    async () => {
      if (modelFailure || serverFailure) throw Error(modelFailure ?? serverFailure);
      const history = await client.request("thread/read", {
        threadId: thread.id,
        includeTurns: true,
      });
      noSecret(history, "Core result history");
      snapshot = history.thread.turns.find((item) => item.id === turn.id);
      return snapshot && snapshot.status !== "inProgress";
    },
    45000,
    `${name} turn`,
  );
  histories.push({ threadId: thread.id, turn: snapshot });
  assert.equal(snapshot.status, "completed", `${name}: Core turn failed`);
  const calls = snapshot.items.filter((item) => item.type === "dynamicToolCall");
  assert.equal(calls.length, 1, `${name}: exactly one actual tool call`);
  assert.equal(calls[0].tool, "run_command");
  assert.equal(spec.rounds, 2, `${name}: model must observe actual result`);
  const receipt = spec.result;
  assert(receipt, `${name}: missing Runtime receipt`);
  assert.equal(receipt.state, "exited", `${name}: not a settled process`);
  assert.equal(receipt.outputReadComplete, true, `${name}: incomplete output`);
  assert.equal(receipt.outputIntegrity, "retained", `${name}: lost output`);
  assert.equal(receipt.signal, null, `${name}: unexpected signal/timeout`);
  assert.equal(receipt.stopReason, null, `${name}: Runtime deadline or limit reached`);
  assert.equal(receipt.sandboxDenied, false, `${name}: permission denial is not a Git result`);
  assert.equal(receipt.commandStatus, success ? "succeeded" : "failed", `${name}: wrong outcome`);
  if (success) assert.equal(receipt.exitCode, 0, `${name}: ${receipt.stderr}`);
  else {
    assert(
      Number.isInteger(receipt.exitCode) && receipt.exitCode > 0,
      `${name}: expected a real nonzero exit`,
    );
    if (stderrPattern) assert.match(receipt.stderr, stderrPattern, `${name}: wrong failure cause`);
  }
  await configurationUnchanged();
  checks.push({
    name,
    threadId: thread.id,
    turnId: turn.id,
    processId: receipt.processId,
    exitCode: receipt.exitCode,
  });
  return receipt;
}
async function processTree(hostPid) {
  const output = await run("/bin/ps", ["-axo", "pid=,ppid=,comm="]);
  const rows = output.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match && { pid: Number(match[1]), parent: Number(match[2]), command: match[3] };
    })
    .filter(Boolean);
  const pids = new Set([hostPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (pids.has(row.parent) && !pids.has(row.pid)) {
        pids.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => pids.has(row.pid));
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
async function stopService(target) {
  assert.equal(target.workspace, workspace, "refuse to stop another workspace");
  assert.equal(target.dataDir, data, "refuse to stop another data directory");
  assert(Number.isSafeInteger(target.hostPid) && target.hostPid > 1, "invalid service host PID");
  assert(Number.isSafeInteger(target.corePid) && target.corePid > 1, "invalid Core PID");
  const tree = await processTree(target.hostPid);
  const ownedPids = new Set([target.hostPid, target.corePid, ...tree.map((row) => row.pid)]);
  const requestId = randomUUID();
  // UNKNOWN 停止结果只查询原操作，不重放 ensure 或切到默认桌面实例。
  let stopError;
  try {
    await cli(
      [
        "service",
        "stop",
        "--json",
        "--instance",
        target.serviceId,
        "--expected-generation",
        target.generation,
        "--request-id",
        requestId,
        "--cancel",
      ],
      45000,
    );
  } catch (error) {
    stopError = error;
  }
  await until(
    async () => {
      const result = await cli(
        [
          "service",
          "operation",
          "--json",
          "--instance",
          target.serviceId,
          "--expected-generation",
          target.generation,
          "--request-id",
          requestId,
        ],
        10000,
      );
      return result.operation?.state === "completed";
    },
    45000,
    `service cleanup${stopError ? ` (${safeError(stopError)})` : ""}`,
  );
  await until(() => [...ownedPids].every((pid) => !alive(pid)), 10000, "service descendant exit");
  cleanup.services.push({
    serviceId: target.serviceId,
    generation: target.generation,
    requestId,
    processes: tree,
    stopped: true,
  });
}
async function scanLogs(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scanLogs(path);
    else if (entry.isFile())
      noSecret((await readFile(path)).toString("utf8"), "Core/service persisted log");
  }
}

try {
  assert(
    process.argv.slice(2).every((arg) => arg === "--keychain"),
    "only --keychain is supported",
  );
  assert(!keychainMode || process.platform === "darwin", "--keychain requires macOS");
  assert(!keychainMode || process.env.HOME?.startsWith("/"), "--keychain requires the login HOME");
  assert(
    !keychainMode || evidence,
    "--keychain requires AREAL_GIT_AUTH_EVIDENCE_DIR for cleanup evidence",
  );
  assert(["darwin", "linux"].includes(process.platform), "requires macOS or Linux");
  await access(bin, constants.X_OK);
  const require = createRequire(import.meta.url);
  const WebSocket = require("ws");
  // macOS 默认 TMPDIR 经 realpath 后常超过服务的 AF_UNIX 上限；使用明确的短目录契约。
  const temporaryRoot =
    process.env.AREAL_GIT_AUTH_TMPDIR ?? (process.platform === "darwin" ? "/tmp" : tmpdir());
  root = await realpath(await mkdtemp(join(temporaryRoot, "ag-")));
  workspace = join(root, "workspace");
  home = join(root, "home");
  data = join(root, "data");
  registry = join(root, "r");
  config = join(root, "config.toml");
  // 服务控制和 SSH agent 都使用 AF_UNIX，过长临时目录必须提前报错而非留下半启动服务。
  assert(
    Buffer.byteLength(join(registry, "services", "x".repeat(24), "control.sock")) < 104,
    "Temporary path is too long for Unix sockets; set AREAL_GIT_AUTH_TMPDIR to an authorized short directory",
  );
  for (const path of [workspace, home, data, registry, join(root, "tmp"), join(root, "harness")])
    await mkdir(path);
  env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: keychainMode ? process.env.HOME : home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    AREAL_HARNESS_HOME: join(root, "harness"),
    AREAL_HARNESS_SERVICE_HOME: registry,
    OTEL_SDK_DISABLED: "true",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    SSH_ASKPASS_REQUIRE: "never",
    SSH_AUTH_SOCK: join(root, "agent.sock"),
    APPLE_SSH_ADD_BEHAVIOR: "openssh",
  };
  await git(["--version"], root);
  await git(["init", "--initial-branch=main", workspace], root);
  phase = "SSH fixture";
  agent = launch("ssh-agent", ["-D", "-a", env.SSH_AUTH_SOCK]);
  agent.child.stdin.end();
  await until(
    async () => {
      assert(!agent.result, "foreground ssh-agent exited before readiness");
      try {
        return (await stat(env.SSH_AUTH_SOCK)).isSocket();
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    },
    5000,
    "SSH agent socket",
  );
  const privateKey = join(root, "signing-key");
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "git-fixture", "-f", privateKey]);
  await run("ssh-add", [privateKey]);
  const publicKey = await readFile(`${privateKey}.pub`, "utf8");
  await copyFile(`${privateKey}.pub`, join(workspace, "signing-key.pub"));
  await writeFile(join(workspace, "allowed-signers"), `fixture@example.invalid ${publicKey}`);
  await rm(privateKey);
  await assert.rejects(access(privateKey), { code: "ENOENT" });
  phase = "HTTPS fixture";
  const remote = await httpsFixture();
  const secretFile = join(home, "fixture-password"),
    helper = join(home, "credential-helper");
  if (keychainMode) {
    phase = "Keychain fixture";
    await initializeKeychain(remote);
  } else {
    await writeFile(secretFile, password, { mode: 0o600 });
  }
  // helper 只接受本测试的精确 loopback 主机；密码仅通过 Git credential 协议输出，不进入模型参数。
  if (!keychainMode)
    await writeFile(
      helper,
      `#!/bin/sh
set -eu
[ "$1" = get ] || exit 0
protocol= host=
while IFS= read -r line && [ -n "$line" ]; do
  case "$line" in
    protocol=*) protocol=\${line#protocol=} ;;
    host=*) host=\${line#host=} ;;
  esac
done
[ "$protocol" = https ] && [ "$host" = 127.0.0.1:${remote.port} ] || exit 1
printf 'username=%s\\npassword=%s\\n\\n' ${quote(username)} "$(cat ${quote(secretFile)})"
`,
      { mode: 0o700 },
    );
  const cfg = (key, value) =>
    git(["config", "--file", join(home, ".gitconfig"), "--add", key, value]);
  for (const [key, value] of [
    ["user.name", "Git Auth Fixture"],
    ["user.email", "fixture@example.invalid"],
    ["user.useConfigOnly", "true"],
    ["commit.gpgSign", "false"],
    ["core.hooksPath", "/dev/null"],
    ["credential.helper", ""],
    ["credential.helper", `!${quote(keychainMode ? keychainHelper : helper)}`],
    ["credential.username", username],
    ["credential.useHttpPath", "true"],
    ["credential.interactive", "false"],
    ["http.sslVerify", "true"],
    ["http.sslCAInfo", remote.ca],
    ["http.proxy", ""],
    ["http.followRedirects", "false"],
    ["http.lowSpeedLimit", "1"],
    ["http.lowSpeedTime", "10"],
  ])
    await cfg(key, value);
  await git(["remote", "add", "origin", remote.url]);
  gitConfig = await readFile(join(home, ".gitconfig"), "utf8");
  localConfig = await readFile(join(workspace, ".git/config"), "utf8");
  await writeFile(join(workspace, "fixture.txt"), "isolated Git auth fixture\n");
  const modelPort = await listen(modelFixture());
  await writeFile(
    config,
    `schema_version = 1
[model]
name = "fixture"
[model.providers.default]
protocol = "chat-completions"
endpoint = "http://127.0.0.1:${modelPort}"
`,
  );
  phase = "service ensure";
  serviceAttempted = true;
  service = await cli([
    "service",
    "ensure",
    "--json",
    "--no-auto-restart",
    "--workspace",
    workspace,
    "--data-dir",
    data,
    "--config",
    config,
    "--sandbox-profile",
    "full-access",
  ]);
  assert.equal(service.state, "ready");
  assert.equal(service.workspace, workspace);
  assert.equal(service.dataDir, data);
  const topology = await processTree(service.hostPid);
  assert(
    topology.some((row) => /(?:^|\/)areal-runtime$/.test(row.command)),
    "shared service must own a real Runtime",
  );
  assert(
    topology.some((row) => row.pid === service.corePid),
    "Core must belong to the shared service",
  );
  const endpoint = new URL(service.endpoint);
  assert.equal(endpoint.hostname, "127.0.0.1");
  const auth = JSON.parse(await readFile(service.authFile, "utf8"));
  client = new CoreClient({
    timeoutMs: 15000,
    createSocket: () => {
      socket = new WebSocket(service.endpoint, {
        headers: { Authorization: `Bearer ${auth.principals[0].token}` },
      });
      return socket;
    },
  });
  await client.connect();
  if (keychainMode) await recordKeychainRecovery();
  checks.push({
    name: "public-service-Core-Runtime",
    serviceId: service.serviceId,
    generation: service.generation,
    topology,
  });
  const head = async (cwd = workspace) => (await git(["rev-parse", "HEAD"], cwd)).stdout.trim();
  await scenario("default-identity", "git add fixture.txt\ngit commit -qm default-identity");
  const identity = (await git(["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).stdout.trim();
  assert.equal(
    identity,
    "Git Auth Fixture <fixture@example.invalid>|Git Auth Fixture <fixture@example.invalid>",
  );
  const signed =
    "git -c gpg.format=ssh -c user.signingkey=signing-key.pub -c commit.gpgSign=true commit --allow-empty -qm";
  const verify =
    "git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=allowed-signers verify-commit HEAD";
  await scenario(
    "ssh-sign-verify",
    `test "$SSH_AUTH_SOCK" = ${quote(env.SSH_AUTH_SOCK)}\ntest ! -e ${quote(privateKey)}\n${signed} signed\n${verify}`,
  );
  const signedHead = await head();
  assert.match(
    (await git(["cat-file", "commit", signedHead])).stdout,
    /gpgsig -----BEGIN SSH SIGNATURE-----/,
  );
  await scenario(
    "ssh-missing-agent",
    `SSH_AUTH_SOCK= ${signed} missing-agent`,
    false,
    /sign|agent|private key/i,
  );
  assert.equal(await head(), signedHead, "failed SSH signing changed HEAD");
  await scenario("https-push", "git push --porcelain origin HEAD:refs/heads/main");
  assert.equal(await head(remote.bare), signedHead, "remote ref differs from pushed commit");
  assert(
    authentication.challenged > 0 && authentication.accepted > 0 && authentication.receivePack > 0,
    "push must authenticate and execute git receive-pack over HTTPS",
  );
  await scenario("next-commit", "git commit --allow-empty -qm rejected-push-candidate");
  const candidate = await head();
  assert.notEqual(candidate, signedHead, "negative push requires an actual pending ref update");
  if (keychainMode) {
    await keychainOperation("store", wrongPassword);
    await keychainOperation("get", wrongPassword);
    keychain.wrongCredentialVerified = true;
  } else {
    await writeFile(secretFile, wrongPassword, { mode: 0o600 });
  }
  const acceptedBefore = authentication.accepted,
    receivedBefore = authentication.receivePack;
  await scenario(
    "https-wrong-credential",
    "git push --porcelain origin HEAD:refs/heads/main",
    false,
    /Authentication failed|401|authentication/i,
  );
  assert(authentication.rejected > 0, "negative control must reach the HTTPS authenticator");
  assert.equal(authentication.accepted, acceptedBefore, "wrong credential was accepted");
  assert.equal(authentication.receivePack, receivedBefore, "wrong credential invoked receive-pack");
  assert.equal(await head(remote.bare), signedHead, "failed push changed remote ref");
  assert.equal(await head(), candidate, "failed push changed local HEAD");
  if (keychainMode) {
    // Git 拒绝认证后应删除错误缓存；缺少凭据也不能意外完成同一个待推送更新。
    await keychainOperation("get");
    await scenario(
      "https-missing-keychain-credential",
      "GIT_TERMINAL_PROMPT=0 git push --porcelain origin HEAD:refs/heads/main",
      false,
      /could not read (?:Username|Password)|unable to get password from user|terminal prompts disabled/i,
    );
    assert.equal(await head(remote.bare), signedHead, "missing credential changed remote ref");
    assert.equal(
      authentication.receivePack,
      receivedBefore,
      "missing credential invoked receive-pack",
    );
  }
  assert.equal((await client.request("areal/server/status")).runtime.activeProcesses, 0);
  await configurationUnchanged();
  checks.push({
    name: "git-state-invariants",
    identity,
    signedHead,
    candidate,
    remoteHead: await head(remote.bare),
    privateKeyRemoved: true,
    configurationUnchanged: true,
  });
  noSecret({ modelRequests, modelResponses, histories, diagnostics }, "model/result logs");
  assert.equal(modelFailure, undefined);
  assert.equal(serverFailure, undefined);
  passed = true;
} catch (error) {
  failure = { phase, message: safeError(error) };
} finally {
  cleaningUp = true;
  let serviceCleanupConfirmed = !serviceAttempted;
  try {
    client?.close();
    socket?.terminate();
  } catch (error) {
    cleanup.errors.push(safeError(error));
  }
  // ensure 即使丢失响应也可能已经启动；只在本测试独立 registry 查询原实例，不重放启动。
  if (serviceAttempted) {
    try {
      const targets = service ? [service] : await cli(["service", "list", "--json"], 15000);
      assert(Array.isArray(targets), "isolated service list must be an array");
      assert(targets.length <= 1, "unexpected service in isolated registry");
      for (const target of targets) {
        if (target.state === "stopped") continue;
        await stopService(target);
      }
      // ensure 被中断且列表为空不能证明未创建；保留未确认状态和恢复记录。
      serviceCleanupConfirmed = targets.length === 1;
    } catch (error) {
      cleanup.errors.push(safeError(error));
    }
  }
  for (const server of servers) {
    try {
      server.closeAllConnections();
      if (server.listening)
        await bounded(new Promise((resolve) => server.close(resolve)), 5000, "server close");
    } catch (error) {
      cleanup.errors.push(safeError(error));
    }
  }
  let childrenCleanupConfirmed = true;
  for (const entry of [...children]) {
    try {
      await terminate(entry);
    } catch (error) {
      childrenCleanupConfirmed = false;
      cleanup.errors.push(safeError(error));
    }
  }
  // 先停止自有服务和 helper，避免在删除后仍有 Git approve/store 将条目重新写入。
  if (keychainMayExist) {
    try {
      await keychainOperation("erase");
      await keychainOperation("get");
      assert(
        serviceCleanupConfirmed && childrenCleanupConfirmed,
        "credential writer stop unconfirmed; a live Git approve/store could restore the test credential",
      );
      keychain.cleanupConfirmed = true;
      await recordKeychainRecovery();
    } catch (error) {
      cleanup.errors.push(`Keychain cleanup: ${safeError(error)}`);
    }
  }
  if (keychainSettings) {
    try {
      assert.deepEqual(await readKeychainSettings(), keychainSettings, "Keychain settings changed");
      keychain.settingsUnchanged = true;
    } catch (error) {
      cleanup.errors.push(safeError(error));
    }
  }
  try {
    noSecret({ modelRequests, modelResponses, histories, diagnostics }, "final model/result logs");
    if (env) for (const path of [data, registry, env.AREAL_HARNESS_HOME]) await scanLogs(path);
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      for (const [name, value] of Object.entries({
        modelRequests,
        modelResponses,
        histories,
        diagnostics,
      }))
        await writeFile(join(evidence, `${name}.json`), JSON.stringify(value, null, 2));
    }
  } catch (error) {
    cleanup.errors.push(safeError(error));
  }
  if (root && !cleanup.errors.length) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      cleanup.temporaryFilesRemoved = true;
    } catch (error) {
      cleanup.errors.push(safeError(error));
    }
  }
  if (cleanup.errors.length || interruption.signal.aborted) passed = false;
  if (interruption.signal.aborted)
    failure ??= { phase, message: safeError(interruption.signal.reason) };
  const report = {
    passed,
    failure,
    modelFailure,
    serverFailure,
    checks,
    authentication,
    keychain,
    cleanup,
    remainingTemporaryRoot: root && !cleanup.temporaryFilesRemoved ? root : null,
    scope: keychainMode
      ? "local macOS login-session Keychain with temporary synthetic credential; full-access shared-service integration; not the original reporter's environment"
      : "deterministic full-access shared-service integration; no real credentials, remote, or model; not a sandbox or agent-quality benchmark",
  };
  console.log(JSON.stringify(report, null, 2));
  if (evidence) {
    try {
      await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
    } catch (error) {
      console.error(safeError(error));
      passed = false;
    }
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  process.exitCode = passed ? 0 : 1;
}
