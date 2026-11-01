import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { connect } from "../examples/desktop-api/client.mjs";
import { respondToSessionName } from "./model-fixture.mjs";

const exec = promisify(execFile);
const repository = await realpath(new URL("..", import.meta.url).pathname);
const root = await realpath(await mkdtemp("/tmp/ah-client-"));
const home = join(root, "home");
const binaryDirectory = resolve(
  process.env.AREAL_TEST_BIN_DIR ?? join(repository, ".local/shared-host-bin"),
);
const binary = join(binaryDirectory, "areal");
const evidencePath = resolve(
  process.env.AREAL_TEST_EVIDENCE ??
    join(repository, ".scratch/shared-host", `clients-${Date.now()}.json`),
);
const scenarios = [
  ["prerequisites", "完整固定真实产物、隔离 home/workspace、源码及产物身份"],
  [
    "exec-and-resume",
    "真实 exec 强杀后原 Turn 完成、Host 部署和 Skill 快照、resume 新 Turn 复用原 run dataDir",
  ],
  ["legacy-and-headless", "真实 -p 与 --prompt 强杀后仅观察原 Turn 完成，不重放提交"],
  ["interactive-kill-resume", "默认交互 TUI 强杀后恢复原 Turn，工具副作用只有一次"],
  ["web-reuse", "Web --json 复用同一 Host 和 TUI 服务"],
].map(([id, contract]) => ({ id, contract, state: "notRun" }));
const evidence = {
  version: 1,
  scope: "H1 ordinary CLI/TUI clients with deterministic local model and real POSIX PTY",
  root,
  home,
  platform: process.platform,
  scenarios,
  excluded: ["GUI", "Remote", "real provider", "package", "manual physical terminal"],
  securityPromptObservation: "notObservedByRunner",
  modelRequests: [],
  processes: [],
  observations: [],
  cleanup: [],
};
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C.UTF-8",
  HOME: join(root, "user"),
  AREAL_HARNESS_HOME: home,
  XDG_CONFIG_HOME: join(root, "preferences"),
  OTEL_SDK_DISABLED: "true",
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
};
const clients = [];
const children = [];
const terminals = [];
const services = new Map();
const held = new Map();
const secrets = new Set();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let activeScenario;
let modelFailure;
let passed = false;
let config;
let tuiProject;
let tuiService;
let hostIdentity;
function sanitize(value) {
  let text = JSON.stringify(value);
  for (const secret of secrets) text = text.replaceAll(secret, "<redacted>");
  return JSON.parse(text);
}
async function phase(id, run) {
  activeScenario = scenarios.find((entry) => entry.id === id);
  activeScenario.state = "running";
  activeScenario.startedAt = new Date().toISOString();
  console.log(`Scenario ${id}`);
  await run();
  if (modelFailure) throw modelFailure;
  activeScenario.state = "passed";
}
async function until(check, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (modelFailure) throw modelFailure;
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw Error(`Timed out waiting for ${message}`);
}
function launch(args, cwd = root) {
  const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const record = { child, args, cwd, stdout: "", stderr: "", exit: null };
  children.push(record);
  child.stdout.on("data", (chunk) => {
    record.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    record.stderr += chunk;
  });
  record.done = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      record.exit = { code, signal };
      done(record);
    });
  });
  return record;
}
async function command(args, cwd = root) {
  const { stdout } = await exec(binary, args, {
    cwd,
    env,
    timeout: 90000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}
async function finish(record) {
  await until(() => record.exit, `client PID ${record.child.pid} exit`, 90000);
  assert.deepEqual(record.exit, { code: 0, signal: null }, record.stderr);
  return record.stdout;
}
async function status() {
  const result = await command(["host", "status", "--json"]);
  for (const project of result.projects)
    if (project.service) services.set(project.service.serviceId, project.service);
  if (hostIdentity) {
    assert.equal(result.hostId, hostIdentity.hostId);
    assert.equal(result.generation, hostIdentity.generation);
  }
  return result;
}
async function serviceFor(dataDir) {
  const project = (await status()).projects.find((item) => item.registration.dataDir === dataDir);
  assert(project?.service, `Host must own service for ${dataDir}`);
  assert.equal(project.service.owner.kind, "host");
  return project.service;
}
async function observer(service) {
  const client = await connect(service.endpoint, service.authFile);
  secrets.add(client.token);
  clients.push(client);
  return client;
}
async function thread(client, threadId) {
  return (await client.call("thread/read", { threadId, includeTurns: true })).thread;
}
async function sessionMapping(workspace) {
  for (const mappingName of await readdir(join(home, "cli/sessions"))) {
    if (!mappingName.endsWith(".json")) continue;
    const mapping = JSON.parse(await readFile(join(home, "cli/sessions", mappingName), "utf8"));
    if (mapping.workspace === workspace)
      return {
        mappingName,
        mapping,
        sessionId: mappingName.slice(0, -5),
        runDir: join(home, "cli/runs", mapping.runId),
      };
  }
  throw Error(`CLI session mapping missing for ${workspace}`);
}
async function killAndObserve(record, service, sessionId, prompt) {
  const initial = await thread(await observer(service), sessionId);
  assert.equal(initial.turns.length, 1);
  assert.equal(initial.turns[0].status, "inProgress");
  const turnId = initial.turns[0].id;
  assert(record.child.kill("SIGKILL"), "admitted client must still be running before kill");
  await record.done;
  assert.deepEqual(record.exit, { code: null, signal: "SIGKILL" });
  const surviving = await serviceFor(service.dataDir);
  assert.equal(surviving.generation, service.generation);
  assert.equal(surviving.corePid, service.corePid);
  const rows = await processRows();
  assert(!rows.some((row) => row.pid === record.child.pid && !row.state.startsWith("Z")));
  assert(rows.some((row) => row.pid === service.corePid && !row.state.startsWith("Z")));
  const client = await observer(surviving);
  const observed = (await client.call("areal/thread/observe", { threadId: sessionId })).thread;
  assert.equal(observed.turns.length, 1);
  assert.equal(observed.turns[0].id, turnId);
  assert.equal(observed.turns[0].status, "inProgress");
  assert(held.has(prompt), "client exit must not cancel the admitted model request");
  held.get(prompt)();
  const completed = await until(async () => {
    const history = await thread(client, sessionId);
    assert.equal(history.turns.length, 1, "observation must not admit a replacement Turn");
    assert.equal(history.turns[0].id, turnId);
    return history.turns[0].status === "completed" && history;
  }, `detached ${prompt} original Turn completion`);
  assert.equal(await readFile(join(record.cwd, `${prompt}-count`), "utf8"), "once\n");
  assert.equal(
    evidence.modelRequests.filter((item) => item.text === prompt && item.toolResults === 0).length,
    1,
  );
  evidence.observations.push({
    scenario: activeScenario.id,
    behavior: "kill-after-admission-observe-only",
    prompt,
    sessionId,
    turnId,
    killedPid: record.child.pid,
    serviceId: service.serviceId,
    generation: service.generation,
    corePid: service.corePid,
    observationMethods: ["areal/thread/observe", "thread/read"],
    sideEffects: 1,
    status: completed.turns[0].status,
  });
  return completed;
}
function reply(response, delta, reason = "stop") {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`,
  );
}
const model = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (respondToSessionName(input, response)) return;
    const text = input.messages.findLast(
      (item) =>
        item.role === "user" &&
        !(
          typeof item.content === "string" &&
          item.content.startsWith("AReaL runtime context (not a user request):")
        ),
    ).content;
    const tools = input.messages.filter((item) => item.role === "tool");
    evidence.modelRequests.push({ text, model: input.model, toolResults: tools.length });
    if (text.startsWith("effect-") && !tools.length) {
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
                  argv: ["/bin/sh", "-c", `printf 'once\n' >> ${text}-count`],
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
    if (text.startsWith("effect-")) {
      assert(!held.has(text), `duplicate model barrier ${text}`);
      const release = () => {
        held.delete(text);
        reply(response, { content: `reply:${text}` });
      };
      held.set(text, release);
      response.once("close", () => {
        if (held.get(text) === release) held.delete(text);
      });
      return;
    }
    reply(response, { content: `reply:${text}` });
  } catch (error) {
    modelFailure = error;
    response.destroy(error);
  }
});
function terminal(args, cwd) {
  const child = spawn(
    "/usr/bin/python3",
    ["-I", "-S", join(repository, "scripts/shared-host-client-pty.py"), binary, ...args],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending = new Map();
  const record = { child, args, cwd, pid: null, stderr: "", screens: [], exit: null };
  terminals.push(record);
  let next = 0;
  let resolveReady;
  let rejectReady;
  record.ready = new Promise((done, reject) => {
    resolveReady = done;
    rejectReady = reject;
  });
  child.stderr.on("data", (chunk) => {
    record.stderr += chunk;
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const value = JSON.parse(line);
    if (value.ready) {
      record.pid = value.pid;
      resolveReady(value);
      return;
    }
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id);
    clearTimeout(entry.timer);
    record.screens.push(value);
    if (value.error)
      entry.reject(Error(`PTY ${value.error}; screen=${value.screen}; driver=${record.stderr}`));
    else entry.done(value);
  });
  child.once("error", rejectReady);
  record.done = new Promise((done) =>
    child.once("exit", (code, signal) => {
      record.exit = { code, signal };
      const error = Error(`PTY driver exited ${code}/${signal}: ${record.stderr}`);
      rejectReady(error);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
      done();
    }),
  );
  record.call = async (operation, text) => {
    await record.ready;
    return new Promise((done, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`PTY control timeout ${operation}`));
      }, 45000);
      pending.set(id, { done, reject, timer });
      child.stdin.write(JSON.stringify({ id, operation, text }) + "\n");
    });
  };
  record.close = async () => {
    child.stdin.end();
    await record.done;
  };
  return record;
}
async function lockAvailable(path) {
  const source =
    "import os,fcntl,sys\nf=os.open(sys.argv[1],os.O_RDWR|os.O_NOFOLLOW)\ntry:\n fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\n print('true')\nexcept BlockingIOError:\n print('false')\nfinally:\n os.close(f)";
  return JSON.parse((await exec("/usr/bin/python3", ["-I", "-S", "-c", source, path])).stdout);
}
async function processRows() {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,stat=,comm="]);
  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [, pid, parent, state, command] = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      return { pid: Number(pid), parent: Number(parent), state, command };
    });
}
async function hostTree(pid) {
  const rows = await processRows();
  const ids = new Set([pid]);
  for (let size = 0; size !== ids.size;) {
    size = ids.size;
    for (const row of rows) if (ids.has(row.parent)) ids.add(row.pid);
  }
  return rows.filter((row) => ids.has(row.pid));
}
const execArgs = (workspace, text, extra = []) => [
  "exec",
  text,
  "--output-format",
  "json",
  "--no-session-name",
  "--workspace",
  workspace,
  "--config",
  config,
  "--allow-write",
  "--permissions",
  "YOLO",
  ...extra,
];
const localArgs = (workspace, dataDir) => [
  "--workspace",
  workspace,
  "--data-dir",
  dataDir,
  "--config",
  config,
  "--allow-write",
  "--permissions",
  "YOLO",
];
try {
  await phase("prerequisites", async () => {
    await mkdir(home, { mode: 0o700 });
    await mkdir(env.HOME);
    const components = {};
    for (const name of [
      "areal",
      "areal-runtime",
      "areal-runtime-fs",
      ...(process.platform === "linux" ? ["areal-runtime-reaper"] : []),
    ]) {
      const path = join(binaryDirectory, name);
      const metadata = await lstat(path);
      assert(
        metadata.isFile() && !metadata.isSymbolicLink(),
        `fixed artifact must be real file ${path}`,
      );
      components[name] = digest(await readFile(path));
    }
    evidence.artifact = {
      directory: binaryDirectory,
      components,
      buildInfo: await command(["build-info"]),
    };
    evidence.source = {
      commit: (await exec("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim(),
      status: (await exec("git", ["status", "--short"], { cwd: repository })).stdout.trim(),
    };
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    config = join(root, "config.toml");
    await writeFile(
      config,
      `schema_version = 1\n[model]\nname = "client-fixture"\nmax_retries = 0\n[model.providers.default]\nprotocol = "chat-completions"\nendpoint = "http://127.0.0.1:${model.address().port}"\n`,
    );
  });
  await phase("exec-and-resume", async () => {
    const workspace = join(root, "exec-workspace");
    const skillRoot = join(workspace, ".agents/skills/client-proof");
    const skillText =
      "---\nname: client-proof\ndescription: synthetic snapshot acceptance fixture\n---\nHOST_CLIENT_SKILL_SNAPSHOT\n";
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), skillText);
    const run = launch(execArgs(workspace, "effect-exec"), workspace);
    await until(() => held.has("effect-exec"), "exec post-tool model barrier");
    hostIdentity = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
    const { mappingName, sessionId, mapping, runDir } = await sessionMapping(workspace);
    assert(
      !(await readdir(runDir)).some((name) => name.startsWith("launch-")),
      "CLI temporary deployment source must be removed after Host ready",
    );
    const service = await serviceFor(join(runDir, "state"));
    const client = await observer(service);
    const admitted = await thread(client, sessionId);
    assert.equal(admitted.id, sessionId);
    assert.equal(admitted.cwd, workspace);
    assert.equal(admitted.turns.length, 1);
    evidence.observations.push({
      scenario: "exec-and-resume",
      behavior: "pre-skill-read-identity",
      sessionId,
      turnId: admitted.turns[0].id,
      dataDir: service.dataDir,
    });
    const launchDir = join(home, "host/launch");
    const deployments = [];
    for (const id of await readdir(launchDir))
      for (const file of await readdir(join(launchDir, id)))
        if (file.startsWith("deployment-") && file.endsWith(".json"))
          deployments.push(join(launchDir, id, file));
    const snapshot = await until(async () => {
      for (const path of deployments) {
        const value = JSON.parse(await readFile(path, "utf8"));
        const skill = value.skills?.find((item) => item.id === "client-proof");
        if (skill) return { path, skill };
      }
      return false;
    }, "Host skill snapshot");
    assert(snapshot.skill.root.startsWith(join(home, "host/launch") + "/"));
    await rm(skillRoot, { recursive: true });
    const page = await client.call("areal/skill/read", {
      threadId: sessionId,
      skill: { id: snapshot.skill.id, revision: snapshot.skill.revision },
    });
    assert.equal(page.text, skillText, "Skill stays readable after original source removal");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), skillText);
    const detached = await killAndObserve(run, service, sessionId, "effect-exec");
    const resumed = JSON.parse(
      await finish(launch(execArgs(workspace, "exec-resumed", ["--resume", sessionId]), workspace)),
    );
    assert.equal(resumed.session_id, sessionId);
    assert.equal(resumed.result, "reply:exec-resumed");
    assert.deepEqual(
      JSON.parse(await readFile(join(home, "cli/sessions", mappingName), "utf8")),
      mapping,
    );
    assert.deepEqual(await readdir(join(home, "cli/runs")), [mapping.runId]);
    const resumedService = await serviceFor(join(runDir, "state"));
    assert.equal(resumedService.serviceId, service.serviceId);
    assert.equal(resumedService.dataDir, service.dataDir);
    const history = await thread(await observer(resumedService), sessionId);
    assert.equal(history.turns.length, 2);
    assert.equal(history.turns[0].id, detached.turns[0].id);
    assert.notEqual(history.turns[1].id, detached.turns[0].id);
    assert(history.turns.every((item) => item.status === "completed"));
    evidence.observations.push({
      scenario: "exec-and-resume",
      sessionId,
      mapping,
      runDir,
      serviceId: service.serviceId,
      deploymentSnapshot: snapshot.path,
      skillSnapshot: snapshot.skill.root,
      skillDigest: digest(skillText),
      turns: history.turns.map((item) => ({ id: item.id, status: item.status })),
    });
  });
  await phase("legacy-and-headless", async () => {
    const workspace = join(root, "legacy-workspace");
    await mkdir(workspace);
    const legacy = execArgs(workspace, "effect-legacy");
    legacy[0] = "-p";
    const legacyClient = launch(legacy, workspace);
    await until(() => held.has("effect-legacy"), "legacy -p post-tool model barrier");
    const legacySession = await sessionMapping(workspace);
    const legacyService = await serviceFor(join(legacySession.runDir, "state"));
    await killAndObserve(legacyClient, legacyService, legacySession.sessionId, "effect-legacy");
    tuiProject = { workspace: join(root, "tui-workspace"), dataDir: join(root, "tui-data") };
    await mkdir(tuiProject.workspace);
    const headless = launch(
      [
        ...localArgs(tuiProject.workspace, tuiProject.dataDir),
        "--prompt",
        "effect-headless",
        "--no-session-name",
      ],
      tuiProject.workspace,
    );
    await until(() => held.has("effect-headless"), "headless TUI post-tool model barrier");
    tuiService = await serviceFor(tuiProject.dataDir);
    const headlessSessionId = headless.stderr.match(/Thread: ([a-f0-9-]{36})/)?.[1];
    assert(headlessSessionId, `headless TUI must publish thread identity: ${headless.stderr}`);
    await killAndObserve(headless, tuiService, headlessSessionId, "effect-headless");
    evidence.observations.push({
      scenario: "legacy-and-headless",
      legacySessionId: legacySession.sessionId,
      headlessSessionId,
      tuiServiceId: tuiService.serviceId,
    });
  });
  await phase("interactive-kill-resume", async () => {
    const args = localArgs(tuiProject.workspace, tuiProject.dataDir);
    const first = terminal(args, tuiProject.workspace);
    await first.call("expect", "Welcome");
    const initial = await first.call("expect", "live");
    const sessionId = initial.screen.match(
      /^[^\w\n]*([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})[^\w\n]*$/m,
    )?.[1];
    assert(sessionId, `Welcome must show thread identity: ${initial.screen}`);
    await first.call("send", "effect-tui\r");
    await until(() => held.has("effect-tui"), "interactive TUI post-tool model barrier");
    const service = await serviceFor(tuiProject.dataDir);
    assert.equal(service.generation, tuiService.generation);
    const client = await observer(service);
    const before = await thread(client, sessionId);
    assert.equal(before.turns.length, 1);
    const turnId = before.turns[0].id;
    assert.equal(await readFile(join(tuiProject.workspace, "effect-tui-count"), "utf8"), "once\n");
    await first.call("kill");
    await first.close();
    const afterKill = await serviceFor(tuiProject.dataDir);
    assert.equal(afterKill.generation, service.generation);
    assert.equal((await thread(client, sessionId)).turns[0].id, turnId);
    assert(held.has("effect-tui"), "killed TUI must not cancel Core-owned Turn");
    const resumed = terminal([...args, "--resume", sessionId], tuiProject.workspace);
    await resumed.call("expect", "effect-tui");
    await resumed.call("expect", "Turn Running");
    const restored = await thread(client, sessionId);
    assert.equal(restored.turns.length, 1);
    assert.equal(restored.turns[0].id, turnId);
    held.get("effect-tui")();
    await resumed.call("expect", "reply:effect-tui");
    await resumed.call("expect", "Turn Completed");
    const completed = await until(async () => {
      const history = await thread(client, sessionId);
      return history.turns[0].status === "completed" && history;
    }, "original interactive Turn completion");
    assert.equal(completed.turns.length, 1);
    assert.equal(completed.turns[0].id, turnId);
    assert.equal(await readFile(join(tuiProject.workspace, "effect-tui-count"), "utf8"), "once\n");
    assert.equal(
      evidence.modelRequests.filter((item) => item.text === "effect-tui" && item.toolResults === 0)
        .length,
      1,
    );
    await resumed.call("exit");
    await resumed.close();
    evidence.observations.push({
      scenario: "interactive-kill-resume",
      sessionId,
      turnId,
      killedPid: first.pid,
      resumedPid: resumed.pid,
      serviceId: service.serviceId,
      generation: service.generation,
      corePid: service.corePid,
      sideEffects: 1,
    });
  });
  await phase("web-reuse", async () => {
    const before = await status();
    const web = await command(
      ["web", "--json", ...localArgs(tuiProject.workspace, tuiProject.dataDir)],
      tuiProject.workspace,
    );
    assert.equal(web.serviceId, tuiService.serviceId);
    assert.equal(web.generation, tuiService.generation);
    assert.equal(web.owner.hostId, hostIdentity.hostId);
    assert.equal((await status()).projects.length, before.projects.length);
    evidence.observations.push({
      scenario: "web-reuse",
      serviceId: web.serviceId,
      generation: web.generation,
      hostId: web.owner.hostId,
    });
    for (const [name, sha256] of Object.entries(evidence.artifact.components))
      assert.equal(
        digest(await readFile(join(binaryDirectory, name))),
        sha256,
        "artifact changed during acceptance",
      );
  });
  passed = true;
} catch (error) {
  if (activeScenario) {
    activeScenario.state = "failed";
    activeScenario.failure = { message: error.message, stack: error.stack };
  }
  process.exitCode = 1;
  console.error(sanitize({ error: error.message, scenario: activeScenario?.id }));
} finally {
  if (modelFailure) evidence.fixtureFailure = modelFailure.message;
  modelFailure = undefined;
  for (const record of terminals) {
    if (!record.exit) {
      const row = (await processRows()).find(
        (item) => item.pid === record.pid && item.parent === record.child.pid,
      );
      if (row) {
        try {
          process.kill(row.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") evidence.cleanup.push({ terminalKillError: error.message });
        }
      }
      record.child.stdin.end();
      await Promise.race([record.done, delay(3000)]);
      if (!record.exit) {
        record.child.kill("SIGKILL");
        await record.done;
      }
    }
  }
  for (const record of children)
    if (!record.exit) {
      record.child.kill("SIGKILL");
      await record.done.catch(() => {});
    }
  for (const client of clients)
    await client
      .close()
      .catch((error) => evidence.cleanup.push({ clientCloseError: error.message }));
  const identity = await readFile(join(home, "host/host.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (identity) {
    const topology = await hostTree(identity.pid);
    evidence.processes.push(...topology);
    await status().catch(() => {});
    const requestId = randomUUID();
    try {
      await command([
        "host",
        "stop",
        "--json",
        "--cancel",
        "--request-id",
        requestId,
        "--expected-generation",
        identity.generation,
      ]);
      const receipt = await until(
        async () => {
          const value = await command(["host", "operation", requestId, "--json"]);
          return value.operation?.state === "completed" && value.operation;
        },
        "Host cleanup receipt",
        60000,
      );
      await until(
        async () => {
          const rows = await processRows();
          return topology.every(
            (item) => !rows.some((row) => row.pid === item.pid && !row.state.startsWith("Z")),
          );
        },
        "owned Host and descendants exit",
        60000,
      );
      for (const service of services.values())
        for (const file of ["owner.lock", "service.lock"])
          assert(
            await lockAvailable(join(service.dataDir, file)),
            `cleanup must release ${service.serviceId}/${file}`,
          );
      assert(await lockAvailable(join(home, "host.lock")), "cleanup must release Host lock");
      evidence.cleanup.push({ state: "passed", receipt, topology });
    } catch (error) {
      passed = false;
      process.exitCode = 1;
      evidence.cleanup.push({ state: "failed", message: error.message, topology });
    }
  }
  if (model.listening) {
    model.closeAllConnections();
    await new Promise((done) => model.close(done));
  }
  evidence.clients = children.map(({ child, done, ...record }) => ({ ...record, pid: child.pid }));
  evidence.terminals = terminals.map(({ child, done, ready, call, close, ...record }) => ({
    ...record,
    driverPid: child.pid,
  }));
  evidence.passed = passed;
  evidence.finishedAt = new Date().toISOString();
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(sanitize(evidence), null, 2));
  console.log(`${passed ? "PASS" : "FAIL"} H1 ordinary clients. Evidence ${evidencePath}`);
}
