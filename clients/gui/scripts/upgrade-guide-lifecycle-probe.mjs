import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { makeTempDir } from "./support/temp.mjs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { cleanupSyntheticHostKeychain, readFixtureHost } from "./application-cleanup.mjs";

// The first stop receipt is evidence: never retry it or manufacture service state.
const root = await makeTempDir("aup-");
const gui = resolve("clients/gui");
const binary = resolve(process.env.AREAL_UPGRADE_OLD_CORE || "target/debug/areal");
const expected = process.env.AREAL_UPGRADE_OLD_CORE_SHA256;
const hash = (value) => createHash("sha256").update(value).digest("hex");
assert.match(expected || "", /^[a-f0-9]{64}$/);
assert.equal(hash(await readFile(binary)), expected, "old Core identity changed");
const require = createRequire(join(gui, "app/package.json"));
const { HostClient } = require("@areal/client/node");
const home = join(root, "host"),
  user = join(root, "user"),
  workspace = join(root, "workspace");
const coreHome = join(root, "core");
const dataDir = join(coreHome, "state");
const scratchDir = join(coreHome, "scratch");
const configPath = join(root, "config.toml");
for (const dir of [home, user, workspace, dataDir, scratchDir])
  await mkdir(dir, { recursive: true, mode: 0o700 });
await writeFile(
  configPath,
  'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:9/v1/chat/completions"\n',
  { mode: 0o600 },
);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AREAL_"))),
  AREAL_HARNESS_HOME: home,
  AREAL_HARNESS_SERVICE_HOME: home,
  AREAL_CORE_HOME: coreHome,
  AREAL_CORE_USER_HOME: user,
  AREAL_GUI_USER_DATA: join(root, "profile"),
};
const report = {
  root,
  binary,
  coreSha256: expected,
  scope: "isolated real service termination and original Host stop receipt",
  pids: {},
  checks: [],
  cleanup: {},
};
const save = () =>
  writeFile(join(root, "result.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
const host = spawn(binary, ["host", "run"], { env, stdio: "ignore" });
report.pids.host = host.pid;
const client = new HostClient();
let servicePid, corePid;
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
try {
  const deadline = Date.now() + 15000;
  while (true) {
    try {
      await client.connect(home);
      break;
    } catch (error) {
      client.close();
      if (host.exitCode !== null || Date.now() >= deadline) throw error;
      await new Promise((done) => setTimeout(done, 30));
    }
  }
  const identity = await readFixtureHost(env);
  assert.equal(identity?.pid, host.pid);
  assert.equal(identity?.hostId, client.hostId);
  assert.equal(identity?.generation, client.generation);
  const projectId = randomUUID();
  await client.registerProject(randomUUID(), {
    projectId,
    workspace,
    dataDir,
    source: { kind: "cli" },
    defaultBinding: true,
  });
  const launch = {
    workspace,
    cwd: workspace,
    configHome: user,
    homedir: user,
    configPath,
    environment: { PATH: process.env.PATH },
    credentialNames: [],
    options: {
      workspace,
      data_dir: dataDir,
      scratch: scratchDir,
      allow_write: true,
      allow_network: false,
      allow_concurrent_writes: false,
      read_only_path: [],
      task_credential_command: [],
      no_deployment_mcp: false,
      sandbox_profile: "native",
    },
  };
  const ensureId = randomUUID();
  report.ensureRequestId = ensureId;
  await save();
  const { project: started, service: descriptor } = await client.ensureProject(
    ensureId,
    projectId,
    launch,
  );
  assert.equal(started.state, "ready");
  assert.equal(descriptor.workspace, await realpath(workspace));
  assert.equal(descriptor.dataDir, await realpath(dataDir));
  const endpoint = new URL(descriptor.endpoint);
  assert.equal(endpoint.protocol, "ws:");
  assert.equal(endpoint.hostname, "127.0.0.1");
  assert.ok(!endpoint.username && !endpoint.password && isAbsolute(descriptor.authFile));
  assert.deepEqual(descriptor.owner, {
    kind: "host",
    hostId: client.hostId,
    generation: client.generation,
  });
  servicePid = descriptor.hostPid;
  assert(Number.isSafeInteger(servicePid) && servicePid > 1 && servicePid !== host.pid);
  corePid = descriptor.corePid;
  assert(
    Number.isSafeInteger(corePid) && corePid > 1 && corePid !== servicePid && corePid !== host.pid,
  );
  report.pids.service = servicePid;
  report.pids.core = descriptor.corePid;
  report.generation = descriptor.generation;
  report.checks.push("real-service-ready-and-owner-verified");
  await save();
  process.kill(servicePid, "SIGTERM");
  report.checks.push("owned-service-sigterm-sent");
  const requestId = randomUUID();
  report.originalStop = { requestId, state: "UNKNOWN" };
  await save();
  const receipt = await client.stop(requestId, client.generation, "ifIdle");
  report.originalStop = { requestId, state: receipt.state };
  report.stopReceipt = receipt;
  report.checks.push("original-stop-returned");
  assert.equal(
    receipt.state,
    "admissionUnknown",
    "real service termination did not produce UNKNOWN",
  );
} catch (error) {
  report.error = { message: error.message, code: error.code };
} finally {
  client.close();
  // This is the exact fixture Host process started above; preserve the original receipt.
  if (host.exitCode === null && host.signalCode === null) host.kill("SIGTERM");
  if (host.exitCode === null && host.signalCode === null)
    await Promise.race([
      new Promise((done) => host.once("exit", done)),
      new Promise((done) => setTimeout(done, 5000)),
    ]);
  report.cleanup.hostExited = host.exitCode !== null || host.signalCode !== null;
  if (corePid && alive(corePid)) {
    process.kill(corePid, "SIGTERM");
    report.cleanup.coreSignal = "SIGTERM";
  }
  const deadline = Date.now() + 5000;
  while ((alive(servicePid) || alive(corePid)) && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 50));
  report.cleanup.serviceExited = !alive(servicePid);
  report.cleanup.coreExited = !alive(corePid);
  if (
    report.originalStop?.state === "completed" &&
    report.cleanup.hostExited &&
    report.cleanup.serviceExited &&
    report.cleanup.coreExited
  )
    report.cleanup.keychain = await cleanupSyntheticHostKeychain(home, root);
  else report.cleanup.keychain = "preserved: original stop not completed or process still alive";
  await save();
  console.log(
    JSON.stringify({
      root,
      checks: report.checks,
      originalStop: report.originalStop,
      error: report.error,
      cleanup: report.cleanup,
    }),
  );
  if (
    report.error ||
    !report.cleanup.hostExited ||
    !report.cleanup.serviceExited ||
    !report.cleanup.coreExited
  )
    process.exitCode = 1;
}
