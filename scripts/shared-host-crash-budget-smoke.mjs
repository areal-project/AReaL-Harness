import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

assert.equal(process.platform, "darwin");
const required = (name) => {
  const value = process.env[name];
  assert(value && isAbsolute(value), `${name} must be an absolute authorized path`);
  return resolve(value);
};
const root = required("AREAL_HOST_SERVICE_ROOT");
const installer = required("AREAL_HOST_SERVICE_INSTALLER");
const binary = required("AREAL_CORE_BIN");
const home = join(root, "home"),
  agents = join(root, "agents");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const label = `org.areal.host.${hash(home).slice(0, 16)}`;
const domain = `gui/${process.getuid()}/${label}`;
const caseRoot = join(root, `crash-budget-${randomUUID()}`);
await mkdir(caseRoot, { mode: 0o700 });
const resultPath = join(caseRoot, "result.json");
const env = {
  ...process.env,
  HOME: join(caseRoot, "user"),
  AREAL_HARNESS_HOME: home,
  AREAL_HARNESS_SERVICE_HOME: home,
};
await mkdir(env.HOME, { mode: 0o700 });
for (const name of ["AREAL_GUI_OWNER", "AREAL_GUI_LIFETIME_FD", "AREAL_GUI_DESKTOP_LIFETIME_FD"])
  delete env[name];
const require = createRequire(new URL("../clients/gui/app/package.json", import.meta.url));
const { HostClient } = require("@areal/client/node");
const execute = promisify(execFile);
const evidence = {
  root,
  home,
  agents,
  label,
  binary,
  installer,
  caseRoot,
  resultPath,
  commands: [],
  crashes: [],
  checks: [],
  passed: false,
  excluded: [
    "real logout/login",
    "Core/Runtime task crash cleanup",
    "Linux",
    "real credentials",
    "signed package",
  ],
  scriptSha256: hash(await readFile(new URL(import.meta.url))),
  timingBoundary:
    "Same-machine wall clock: descriptor write time precedes publication; ready observation includes polling overhead and is not minimum-delay proof.",
};
let registered = false,
  installAttempted = false,
  pendingStop;
const clients = [];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = () => writeFile(resultPath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function until(read, label) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Deadline: ${label}`);
}
async function command(program, args, allowFailure = false) {
  const row = { program, args };
  evidence.commands.push(row);
  await save();
  try {
    const value = await execute(program, args, { env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    Object.assign(row, { exit: 0, ...value });
    await save();
    return value.stdout;
  } catch (error) {
    Object.assign(row, { exit: error.code, stdout: error.stdout, stderr: error.stderr });
    await save();
    if (!allowFailure) throw error;
    return null;
  }
}
async function manager() {
  const text = await command("/bin/launchctl", ["print", domain]);
  return {
    text,
    pid: Number(text.match(/^\s*pid = (\d+)\s*$/m)?.[1]) || null,
    runs: Number(text.match(/^\s*runs = (\d+)\s*$/m)?.[1]),
  };
}
async function ready(previous) {
  return until(async () => {
    const path = join(home, "host/host.json");
    if (!(await exists(path))) return null;
    const identity = await json(path);
    if (identity.generation === previous?.generation || !alive(identity.pid)) return null;
    const client = new HostClient();
    await client.connect(home);
    clients.push(client);
    assert.equal(client.hostId, identity.hostId);
    assert.equal(client.generation, identity.generation);
    const status = await client.status();
    assert.deepEqual(status.projects, []);
    const run = await json(join(home, "host/service-run.json"));
    assert.equal(run.pid, identity.pid);
    assert.equal(run.managed, true);
    assert.equal(run.active, true);
    const managed = await manager();
    assert.equal(managed.pid, identity.pid);
    const processCommand = (
      await command("/bin/ps", ["-p", String(identity.pid), "-o", "command="])
    ).trim();
    assert.equal(processCommand, `${binary} host run --managed`);
    const descriptorWrittenAtNs = (await stat(path, { bigint: true })).mtimeNs.toString();
    assert.deepEqual(await json(path), identity);
    client.close();
    return {
      identity,
      status,
      run,
      manager: managed,
      descriptorWrittenAtNs,
      observedAtMs: Date.now(),
    };
  }, "authenticated managed Host ready");
}
async function originalStop() {
  const reference = pendingStop;
  const value = JSON.parse(
    await command(binary, ["host", "operation", reference.requestId, "--json"]),
  ).operation;
  assert(value, "original cleanup stop UNKNOWN; retain registration and do not replay");
  assert.equal(value.requestId, reference.requestId);
  assert.equal(value.hostId, reference.hostId);
  assert.equal(value.generation, reference.generation);
  assert.equal(value.state, "completed");
  return value;
}
try {
  assert.equal(await exists(join(home, "host/host.json")), false);
  assert.equal(
    JSON.parse(await command(binary, ["host", "service-status", "--json"])).installed,
    false,
  );
  assert.equal(await command("/bin/launchctl", ["print", domain], true), null);
  const prior = await json(join(home, "host/service-run.json"));
  const stop = await json(join(home, "host/stop.json"));
  assert.equal(prior.active, false);
  assert.deepEqual(prior.crashes, []);
  assert.equal(prior.crashLoopStopped, false);
  assert.equal(stop.state, "completed");
  assert.notEqual(prior.acknowledgedStopRequestId, stop.requestId);
  evidence.before = { run: prior, stopRequestId: stop.requestId };
  evidence.artifact = {
    entry: binary,
    actual: await realpath(binary),
    sha256: hash(await readFile(binary)),
    version: (await command(binary, ["--version"])).trim(),
    build: JSON.parse(await command(binary, ["build-info"])),
  };
  evidence.installerSha256 = hash(await readFile(installer));
  const preview = join(caseRoot, "descriptor-preview.plist");
  await writeFile(preview, await command(installer, ["--describe"]));
  const descriptor = JSON.parse(
    await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", preview]),
  );
  assert.equal(descriptor.Label, label);
  assert.deepEqual(descriptor.ProgramArguments, [binary, "host", "run", "--managed"]);
  assert.equal(descriptor.EnvironmentVariables.AREAL_HARNESS_HOME, home);
  assert.equal(descriptor.EnvironmentVariables.AREAL_HARNESS_SERVICE_HOME, home);
  assert.deepEqual(descriptor.KeepAlive, { SuccessfulExit: false });
  assert.equal(descriptor.ThrottleInterval, 1);
  installAttempted = true;
  evidence.installAttempted = true;
  await save();
  await command(installer, ["install"]);
  registered = true;
  await until(async () => !(await manager()).pid, "passive start honors prior completed stop");
  await command(binary, ["host", "run"]);
  let current = await ready();
  const stableId = current.identity.hostId;
  evidence.initial = current;
  assert.deepEqual(current.run.crashes, []);
  for (const [index, seconds] of [1, 2, 4, 8, 16, null].entries()) {
    const row = {
      index: index + 1,
      before: current,
      signal: "SIGKILL",
      dispatchedAtMs: Date.now(),
      expectedDelaySeconds: seconds,
    };
    evidence.crashes.push(row);
    await save();
    const client = new HostClient();
    await client.connect(home);
    clients.push(client);
    assert.equal(client.hostId, stableId);
    assert.equal(client.generation, current.identity.generation);
    assert.deepEqual((await client.status()).projects, []);
    client.close();
    assert.equal((await manager()).pid, current.identity.pid);
    assert.equal((await json(join(home, "host/service-run.json"))).pid, current.identity.pid);
    process.kill(current.identity.pid, "SIGKILL");
    await until(() => !alive(current.identity.pid), "exact crashed Host exit");
    if (seconds !== null) {
      const next = await ready(current.identity);
      assert.equal(next.identity.hostId, stableId);
      assert.notEqual(next.identity.pid, current.identity.pid);
      assert.equal(next.run.crashes.length, index + 1);
      const startedAt = next.run.crashes.at(-1);
      assert(Number.isSafeInteger(startedAt));
      row.observedDelayMs = next.observedAtMs - startedAt;
      const writtenAfterNs = BigInt(next.descriptorWrittenAtNs) - BigInt(startedAt) * 1000000n;
      row.descriptorWrittenAfterMs = Number(writtenAfterNs) / 1000000;
      assert(
        writtenAfterNs >= BigInt(seconds) * 1000000000n,
        "published Host obeys the persisted restart backoff",
      );
      row.after = next;
      current = next;
      await save();
      console.log(
        JSON.stringify({
          stage: "automatic-restart",
          attempt: index + 1,
          expectedDelaySeconds: seconds,
          observedDelayMs: row.observedDelayMs,
          descriptorWrittenAfterMs: row.descriptorWrittenAfterMs,
        }),
      );
    }
  }
  const terminalRun = await until(async () => {
    const value = await json(join(home, "host/service-run.json"));
    return value.crashLoopStopped && value;
  }, "crash-loop terminal budget");
  assert.equal(terminalRun.active, false);
  assert.equal(terminalRun.crashes.length, 6);
  assert(terminalRun.crashes.at(-1) - terminalRun.crashes[0] < 300000);
  const terminalManager = await until(async () => {
    const value = await manager();
    return !value.pid && /last exit code = 0/.test(value.text) && value;
  }, "manager terminal successful exit prevents restart");
  assert(Number.isSafeInteger(terminalManager.runs));
  await delay(2100);
  const quiet = await manager();
  assert.equal(quiet.pid, null);
  assert.equal(quiet.runs, terminalManager.runs);
  const status = JSON.parse(await command(binary, ["host", "status", "--json"]));
  assert.equal(status.state, "crashLoopStopped");
  assert.equal(status.automaticRestarts, 5);
  assert.equal(status.hostId, stableId);
  assert.equal(status.stopIntent, false);
  evidence.terminal = {
    run: terminalRun,
    manager: terminalManager,
    quiet,
    status,
    observationMs: 2100,
  };
  evidence.checks.push(
    "launchd restarts the exact empty Host five times with persisted 1/2/4/8/16-second backoff",
  );
  evidence.checks.push(
    "the sixth crash reaches crashLoopStopped, reports five automatic restarts, and exits zero under launchd",
  );
  await command(binary, ["host", "run"]);
  const resumed = await ready(current.identity);
  assert.equal(resumed.identity.hostId, stableId);
  assert.deepEqual(resumed.run.crashes, []);
  assert.equal(resumed.run.crashLoopStopped, false);
  evidence.resumed = resumed;
  evidence.checks.push(
    "explicit start clears the terminal budget and returns the same stable managed Host identity",
  );
  const client = new HostClient();
  await client.connect(home);
  clients.push(client);
  pendingStop = {
    requestId: randomUUID(),
    hostId: client.hostId,
    generation: client.generation,
    strategy: "ifIdle",
  };
  evidence.pendingStop = pendingStop;
  await save();
  try {
    evidence.stopReply = await client.stop(pendingStop.requestId, pendingStop.generation, "ifIdle");
  } catch (error) {
    evidence.stopReplyError = { code: error.code, message: error.message };
  }
  evidence.stop = await originalStop();
  client.close();
  await until(
    async () => !alive(resumed.identity.pid) && !(await exists(join(home, "host/host.json"))),
    "original cleanup stop exits",
  );
  await command(binary, ["host", "uninstall", "--stopped-only"]);
  registered = false;
  installAttempted = false;
  assert.equal(await command("/bin/launchctl", ["print", domain], true), null);
  assert.equal(await exists(join(agents, `${label}.plist`)), false);
  assert.equal(
    JSON.parse(await command(binary, ["host", "service-status", "--json"])).installed,
    false,
  );
  assert.equal(await json(join(home, "host/identity.json")), stableId);
  evidence.checks.push(
    "the original cleanup stop completes and stopped-only uninstall removes the exact service while retaining identity",
  );
  evidence.passed = true;
} catch (error) {
  evidence.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  for (const client of clients) client.close();
  evidence.cleanupRequired = registered || installAttempted;
  if (evidence.cleanupRequired)
    evidence.cleanupInstruction =
      "Retain the service registration. Query only a recorded original stop ID; no automatic stop, kill, restart, or uninstall after failure.";
  if (evidence.artifact) assert.equal(hash(await readFile(binary)), evidence.artifact.sha256);
  await save();
  console.log(resultPath);
}
