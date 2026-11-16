import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { on, once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { HostClient } from "../packages/client/node/host-client.cjs";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const WebSocket = require("ws");
const binary = resolve(process.env.AREAL_CORE_BIN || "../../target/debug/areal");
const root = await trackedMkdtemp(join(tmpdir(), "areal-activation-"));
const home = join(root, "host"),
  workspace = join(root, "workspace"),
  data = join(root, "data");
for (const path of [home, workspace, data]) await mkdir(path, { mode: 0o700 });
const config = join(root, "config.toml");
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
let socket, messages;
async function waitForExit(pid) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    assert.ok(Date.now() < deadline, "owned Host has not exited");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function rpc(method, params, context) {
  const id = randomUUID();
  socket.send(JSON.stringify({ version: 1, id, method, params, ...(context ? { context } : {}) }));
  let timer;
  let response;
  try {
    response = await Promise.race([
      (async () => {
        for (;;) {
          const { value, done } = await messages.next();
          if (done) throw Error("Host connection closed");
          const reply = JSON.parse(value[0].toString());
          if (reply.id === id) return reply;
        }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("activation reply deadline")), 30000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(response.error, undefined);
  return response.result;
}
try {
  await host.connectOrStart(home, binary);
  await host.registerProject(randomUUID(), {
    projectId,
    workspace,
    dataDir: data,
    source: { kind: "cli" },
    defaultBinding: false,
  });
  const { stdout } = await promisify(execFile)(
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
      data,
      "--config",
      config,
      "--allow-write",
      "--permissions",
      "YOLO",
    ],
    { env, cwd: workspace, timeout: 90000 },
  );
  const initial = JSON.parse(stdout).service;
  const stopped = await host.stopProject(
    randomUUID(),
    projectId,
    initial.generation,
    "ifIdle",
    false,
  );
  assert.equal(stopped.state, "completed");
  const ticket = await host.request("web.ticket", {
    origin: "areal-ui://app",
    expectedGeneration: host.generation,
  });
  socket = new WebSocket(ticket.websocketUrl, { origin: ticket.origin });
  messages = on(socket, "message");
  await once(socket, "open");
  const hello = await rpc("hello", {
    protocolVersions: [1],
    capabilities: ["gui-read-v1", "gui-write-v1"],
    ticket: ticket.ticket,
    expectedGeneration: ticket.generation,
  });
  assert.ok(hello.writeMethods.includes("project.activate"));
  const statistics = await rpc("analytics.read", {});
  assert.equal(statistics.tokens, 0);
  const imported = await rpc("analytics.import", {
    state: { version: 1, since: 1, days: { "2026-11-05": 1250.5 }, turns: {}, skills: {} },
  });
  assert.equal(imported.activeMs, 1250.5);
  assert.equal((await host.request("backend.status", {})).owned, false);
  evidence.reached.push("Host reads and imports analytics over the product socket without Node");
  const activated = await rpc("project.activate", {}, { projectId });
  assert.equal(activated.state, "ready");
  assert.notEqual(activated.serviceGeneration, initial.generation);
  const resumed = (await host.status()).projects.find(
    (p) => p.registration.projectId === projectId,
  );
  assert.equal(resumed.state, "ready");
  assert.equal(resumed.service.generation, activated.serviceGeneration);
  assert.notEqual(resumed.scheduleActivationSuppressed, true);
  assert.equal((await host.request("backend.status", {})).owned, false);
  const same = await rpc("project.activate", {}, { projectId });
  assert.equal(same.serviceGeneration, activated.serviceGeneration);
  evidence.reached.push(
    "cold project wakes through Host with no desktop command",
    "ready activation reuses the same Core generation",
  );
  assert.equal(
    (await host.stopProject(randomUUID(), projectId, resumed.service.generation, "ifIdle")).state,
    "completed",
  );
  const blocked = await rpc("project.activate", {}, { projectId });
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.reason, "explicitlyStopped");
  assert.equal(
    (await host.status()).projects.find((p) => p.registration.projectId === projectId).state,
    "stopped",
  );
  evidence.reached.push("explicit stop remains suppressed and cannot be implicitly resumed");
  evidence.passed = true;
} catch (error) {
  evidence.firstFailure = error.message;
  process.exitCode = 1;
} finally {
  socket?.terminate();
  await messages?.return();
  try {
    const hostPid = host.identity.pid;
    const receipt = await host.stop(randomUUID(), host.generation, "cancel");
    assert.equal(receipt.state, "completed");
    host.close();
    await waitForExit(hostPid);
    evidence.cleanup = "original Host stop completed and process exited";
  } catch (error) {
    evidence.cleanup = error.message;
    evidence.passed = false;
    process.exitCode = 1;
  }
  host.close();
  const path = join(root, "result.json");
  await writeFile(path, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, evidence: path }));
}
