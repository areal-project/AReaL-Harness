import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const { HostClient } = require("../app/src/core/host-client.cjs");
const exec = promisify(execFile);
const binary = join(
  process.env.AREAL_TEST_BIN_DIR ?? join(repository, ".local/shared-host-bin"),
  "areal",
);
const root = await realpath(await mkdtemp("/tmp/ah-gui-projects-"));
const home = join(root, "host-home");
const source = {
  profile: join(root, "profile"),
  coreHome: join(root, "core"),
  legacyServiceHome: join(root, "legacy"),
};
for (const path of [home, ...Object.values(source), join(root, "user")])
  await mkdir(path, { mode: 0o700 });
await writeFile(join(source.coreHome, "projects.json"), "[]\n", { mode: 0o600 });
const env = {
  PATH: process.env.PATH,
  HOME: join(root, "user"),
  AREAL_HARNESS_HOME: home,
  AREAL_HARNESS_SERVICE_HOME: home,
  OTEL_SDK_DISABLED: "true",
};
const evidence = {
  root,
  scope: "Native Host and Node GUI SDK with isolated projects and empty secret manifest",
  binary,
  sha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  checks: [],
  processes: [],
  excluded: ["Electron UI", "legacy Desktop fencing", "Keychain", "real provider", "package"],
};
const clients = [];
const processes = [];
async function startHost() {
  const child = spawn(binary, ["host", "run"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ error: error.message }));
  });
  const process = { child, done };
  processes.push(process);
  const deadline = Date.now() + 15_000;
  for (;;) {
    let descriptor;
    try {
      descriptor = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (descriptor?.pid === child.pid) break;
    if (child.exitCode !== null || Date.now() >= deadline)
      throw new Error(`Host startup failed: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return process;
}
async function connect() {
  const client = new HostClient();
  clients.push(client);
  await client.connect(home);
  return client;
}
async function stopHost(process, client) {
  const stopped = await client.request("host.stop", {
    requestId: randomUUID(),
    expectedGeneration: client.generation,
    strategy: "ifIdle",
  });
  assert.equal(stopped.state, "completed");
  client.close();
  const timeout = setTimeout(() => process.child.kill("SIGTERM"), 5000);
  const exit = await process.done;
  clearTimeout(timeout);
  evidence.processes.push({ pid: process.child.pid, ...exit });
  assert.equal(exit.code, 0);
}

try {
  const first = await startHost();
  const client = await connect();
  assert.equal(await client.sourceState(source), null);
  const legacyId = createHash("sha256").update("ordinary-gui-project").digest("hex").slice(0, 24);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const registration = {
    projectId: randomUUID(),
    workspace,
    dataDir: join(source.coreHome, legacyId, "state"),
    source: { kind: "gui", profile: source.profile, legacyProjectId: legacyId },
    defaultBinding: true,
  };
  await assert.rejects(client.registerProject(randomUUID(), registration));
  assert.deepEqual((await client.listProjects()).projects, []);
  evidence.checks.push("unpublished-source-rejected");

  await client.attachSource(source);
  const migrationId = randomUUID();
  assert.equal((await client.importSource(migrationId, source)).kind, "ready");
  const original = await client.sourceState(source);
  assert.equal(original.migrationId, migrationId);
  assert.deepEqual(original.bindings, []);
  const requestId = randomUUID();
  const registered = await client.registerProject(requestId, registration);
  assert.deepEqual(registered.registration, registration);
  assert.deepEqual(await client.registerProject(requestId, registration), registered);
  const listed = await client.listProjects();
  assert.deepEqual(listed.projects, [registration]);
  const current = await client.sourceState(source);
  assert.equal(current.bindings.length, 1);
  assert.equal(current.bindings[0].projectId, registration.projectId);
  assert.equal(current.bindings[0].alias.legacyProjectId, legacyId);
  assert.equal(current.bindings[0].scratchDir, join(source.coreHome, legacyId, "scratch"));
  await assert.rejects(
    client.registerProject(randomUUID(), { ...registration, projectId: randomUUID() }),
  );
  assert.deepEqual(await client.sourceState(source), current);
  evidence.checks.push("gui-alias-registration-and-original-receipt");

  const journal = client.journal(registration.projectId);
  assert.deepEqual(await journal.read(), {
    revision: 0,
    snapshot: { version: 1, pending: [], outcomes: {} },
  });
  const secondClient = await connect();
  const other = secondClient.journal(registration.projectId);
  const pending = [randomUUID(), randomUUID()].map((requestId) => ({
    method: "areal/thread/start",
    params: { requestId, text: "keep original unresolved request" },
    evidence: "UNKNOWN",
  }));
  await Promise.all([
    journal.change((snapshot) => ({ ...snapshot, pending: [...snapshot.pending, pending[0]] })),
    other.change((snapshot) => ({ ...snapshot, pending: [...snapshot.pending, pending[1]] })),
  ]);
  const saved = await journal.read();
  assert.equal(saved.revision, 2);
  assert.deepEqual(
    saved.snapshot.pending.map((entry) => entry.params.requestId).sort(),
    pending.map((entry) => entry.params.requestId).sort(),
  );
  evidence.checks.push("ordinary-gui-journal-and-two-client-cas");

  const cliWorkspace = join(root, "cli-workspace");
  await mkdir(cliWorkspace);
  const cli = {
    projectId: "cli-existing-project",
    workspace: cliWorkspace,
    dataDir: join(root, "cli-data"),
    source: { kind: "cli" },
    defaultBinding: true,
  };
  await client.registerProject(randomUUID(), cli);
  assert.deepEqual((await client.journal(cli.projectId).read()).snapshot, {
    version: 1,
    pending: [],
    outcomes: {},
  });
  evidence.checks.push("cli-project-first-gui-journal");
  secondClient.close();
  await stopHost(first, client);

  const second = await startHost();
  const restarted = await connect();
  assert.deepEqual(await restarted.sourceState(source), current);
  assert.deepEqual(await restarted.journal(registration.projectId).read(), saved);
  assert.deepEqual((await restarted.operation(requestId)).operation.result, registered);
  evidence.checks.push("source-alias-and-journal-survive-host-restart");
  await stopHost(second, restarted);
  const offline = await exec(binary, ["host", "operation", requestId], { cwd: root, env });
  assert.equal(JSON.parse(offline.stdout).operation.state, "completed");
  evidence.checks.push("offline-original-registration-receipt");
  evidence.state = "passed";
} catch (error) {
  evidence.state = "failed";
  evidence.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  for (const client of clients) client.close();
  for (const process of processes) {
    if (process.child.exitCode === null && process.child.signalCode === null) {
      process.child.kill("SIGTERM");
      const timeout = setTimeout(() => process.child.kill("SIGKILL"), 5000);
      evidence.processes.push({ pid: process.child.pid, cleanup: await process.done });
      clearTimeout(timeout);
    }
  }
  const evidencePath = resolve(process.env.AREAL_TEST_EVIDENCE ?? join(root, "result.json"));
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ state: evidence.state, evidencePath, checks: evidence.checks }));
}
