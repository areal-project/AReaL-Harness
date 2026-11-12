import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { cleanupSyntheticHostKeychain } from "./application-cleanup.mjs";

// The first stop receipt is evidence: never retry it or manufacture service state.
const root = await realpath(await trackedMkdtemp("/private/tmp/areal-upgrade-probe-"));
const gui = resolve("clients/gui");
const binary = resolve(process.env.AREAL_UPGRADE_OLD_CORE || "target/debug/areal");
const expected = process.env.AREAL_UPGRADE_OLD_CORE_SHA256;
const hash = (value) => createHash("sha256").update(value).digest("hex");
assert.match(expected || "", /^[a-f0-9]{64}$/);
assert.equal(hash(await readFile(binary)), expected, "old Core identity changed");
const require = createRequire(join(gui, "app/package.json"));
const { GuiHostProjects } = require("@areal/workbench-service/desktop/core/gui-host-projects.cjs");
const home = join(root, "host"),
  user = join(root, "user"),
  workspace = join(root, "workspace");
const source = {
  profile: join(root, "profile"),
  coreHome: join(root, "core"),
  legacyServiceHome: home,
};
for (const dir of [home, user, workspace, source.profile, source.coreHome])
  await mkdir(dir, { recursive: true, mode: 0o700 });
const env = {
  ...process.env,
  AREAL_HARNESS_HOME: home,
  AREAL_HARNESS_SERVICE_HOME: home,
  AREAL_CORE_HOME: source.coreHome,
  AREAL_CORE_USER_HOME: user,
  AREAL_GUI_USER_DATA: source.profile,
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
const owner = new GuiHostProjects({ binary, home, source, singletonHeld: true });
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
      await owner.init();
      break;
    } catch (error) {
      if (host.exitCode !== null || Date.now() >= deadline) throw error;
      await new Promise((done) => setTimeout(done, 30));
    }
  }
  const id = hash(workspace).slice(0, 24);
  const project = { id, root: workspace };
  await owner.register(randomUUID(), project);
  await writeFile(join(source.coreHome, "projects.json"), JSON.stringify([project]), {
    mode: 0o600,
  });
  const binding = owner.resolve(id);
  await mkdir(binding.scratchDir, { recursive: true, mode: 0o700 });
  const launch = {
    workspace,
    cwd: workspace,
    configHome: user,
    homedir: user,
    environment: { PATH: process.env.PATH },
    credentialNames: [],
    options: {
      workspace,
      data_dir: binding.dataDir,
      scratch: binding.scratchDir,
      allow_write: true,
      allow_network: false,
      allow_concurrent_writes: false,
      read_only_path: [],
      task_credential_command: [],
      no_deployment_mcp: false,
      sandbox_profile: "native",
    },
  };
  const started = await owner.ensure(randomUUID(), id, launch);
  const descriptor = started.descriptor;
  assert.equal(descriptor.owner.kind, "host");
  assert.equal(descriptor.owner.hostId, owner.client.hostId);
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
  const receipt = await owner.client.stop(requestId, owner.client.generation, "ifIdle");
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
  owner.close();
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
