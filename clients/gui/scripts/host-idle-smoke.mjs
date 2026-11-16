import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { HostClient } from "../packages/client/node/host-client.cjs";

const execute = promisify(execFile);
const binary = resolve(process.env.AREAL_CORE_BIN || "../../target/debug/areal");
const root = await trackedMkdtemp(join(tmpdir(), "areal-host-idle-"));
const home = join(root, "host");
const workspace = join(root, "workspace");
const dataDir = join(root, "data");
const config = join(root, "config.toml");
for (const path of [home, workspace, dataDir]) await mkdir(path, { mode: 0o700 });
await writeFile(config, "schema_version=1\n", { mode: 0o600 });
const env = {
  PATH: process.env.PATH,
  HOME: root,
  AREAL_HARNESS_HOME: home,
  AREAL_HARNESS_SERVICE_HOME: home,
  NO_PROXY: "127.0.0.1,localhost",
};
const host = new HostClient();
const projectId = randomUUID();
const evidence = { passed: false, reached: [], cleanup: null };
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
async function until(read, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw Error(message);
}
async function ensure() {
  const { stdout } = await execute(
    binary,
    [
      "host",
      "ensure",
      "--json",
      "--project-id",
      projectId,
      "--workspace",
      workspace,
      "--data-dir",
      dataDir,
      "--config",
      config,
      "--allow-write",
      "--permissions",
      "YOLO",
    ],
    { env, cwd: workspace, timeout: 90000 },
  );
  return JSON.parse(stdout).service;
}
try {
  await host.connectOrStart(home, binary);
  await host.registerProject(randomUUID(), {
    projectId,
    workspace,
    dataDir,
    source: { kind: "cli" },
    defaultBinding: false,
  });
  const initial = await ensure();
  assert.equal(initial.state, "ready");
  evidence.reached.push("original Core ready");
  const started = Date.now();
  console.log("Waiting for the production fifteen-minute idle policy", root);
  const stopped = await until(
    async () => {
      const status = await host.status();
      return (
        status.projects.find((project) => project.registration.projectId === projectId)?.state ===
        "stopped"
      );
    },
    17 * 60 * 1000,
    "idle Core did not hibernate",
  );
  assert.ok(stopped);
  assert.ok(Date.now() - started >= 15 * 60 * 1000, "must honor the production idle TTL");
  await until(
    () => !alive(initial.hostPid) && !alive(initial.corePid),
    30000,
    "Core processes still alive",
  );
  const scheduling = JSON.parse(await readFile(join(home, "host/scheduling.json"), "utf8"));
  assert.notEqual(
    scheduling.projects[projectId]?.suppressed,
    true,
    "hibernation must preserve scheduling intent",
  );
  evidence.reached.push("idle Core exited without suppressing scheduling");
  const resumed = await ensure();
  assert.equal(resumed.state, "ready");
  assert.notEqual(resumed.generation, initial.generation);
  assert.equal(resumed.serviceId, initial.serviceId);
  evidence.reached.push("same project reactivated in a new generation");
  evidence.passed = true;
} catch (error) {
  evidence.firstFailure = error.message;
  process.exitCode = 1;
} finally {
  try {
    if (!host.socket) await host.connect(home);
    const pid = host.identity.pid;
    const receipt = await host.stop(randomUUID(), host.generation, "cancel");
    assert.equal(receipt.state, "completed");
    host.close();
    await until(() => !alive(pid), 30000, "test Host did not exit");
    evidence.cleanup = "owned Host exited";
  } catch (error) {
    evidence.cleanup = error.message;
    evidence.passed = false;
    process.exitCode = 1;
  } finally {
    host.close();
  }
  const path = join(root, "result.json");
  await writeFile(
    path,
    JSON.stringify({ ...evidence, binary: join(dirname(binary), "areal") }, null, 2),
  );
  console.log(JSON.stringify({ ...evidence, evidence: path }));
}
