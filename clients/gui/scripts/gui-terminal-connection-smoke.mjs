import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../../examples/desktop-api/client.mjs";

const { HostClient } = createRequire(new URL("../app/package.json", import.meta.url))(
  "@areal/client/node",
);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const binary = join(
  process.env.AREAL_TEST_BIN_DIR ?? join(repository, ".local/shared-host-bin"),
  "areal",
);
const root = await realpath(await mkdtemp("/tmp/ah-terminal-"));
const home = join(root, "host");
const workspace = join(root, "workspace");
const user = join(root, "user");
const scratch = join(root, "scratch");
for (const path of [home, workspace, user, scratch]) await mkdir(path, { mode: 0o700 });
const deployment = join(root, "deployment.json");
const config = join(user, "terminal-config.toml");
await writeFile(
  config,
  'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:9/v1/chat/completions"\n',
);
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      {
        id: "terminal",
        revision: "v1",
        displayName: "Terminal",
        instructions: "",
        allowThreadProcesses: true,
        allowConnectionProcesses: true,
      },
      {
        id: "legacy",
        revision: "v1",
        displayName: "Legacy",
        instructions: "",
        allowThreadProcesses: true,
      },
    ],
  }),
);
const host = new HostClient();
const owners = [];
const checks = [];
let observer;
let service;

async function until(check, message) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const result = await check();
    if (result) return result;
    assert.ok(Date.now() < deadline, message);
    await new Promise((done) => setTimeout(done, 30));
  }
}

function terminalOwner(descriptor) {
  const source = `
    const { GuiTerminalConnections } = require(process.argv[1]);
    const connections = new GuiTerminalConnections();
    process.on("message", async ({id, request}) => {
      if (request === "close") {
        connections.close();
        process.send({id, result: true}, () => process.exit(0));
        return;
      }
      try { process.send({id, result: await connections.request(request)}); }
      catch (error) { process.send({id, error: {message: error.message, code: error.code}}); }
    });
  `;
  const child = spawn(
    process.execPath,
    [
      "-e",
      source,
      join(repository, "services/workbench/src/desktop/core/gui-terminal-connections.cjs"),
    ],
    {
      env: { PATH: process.env.PATH, HOME: user },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (bytes) => (stderr += bytes));
  const pending = new Map();
  child.on("message", (message) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error)
      request.reject(Object.assign(new Error(message.error.message), message.error));
    else request.resolve(message.result);
  });
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  child.on("exit", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`terminal owner exited: ${stderr}`));
    }
    pending.clear();
  });
  const send = (request) =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("terminal owner response timeout; query original receipt"));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, request });
    });
  const owner = {
    child,
    exited,
    request: (method, params) => send({ ...descriptor, method, params }),
    close: () => send("close"),
  };
  owners.push(owner);
  return owner;
}

try {
  await host.connectOrStart(home, binary);
  await host.registerProject(randomUUID(), {
    projectId: "terminal-project",
    workspace,
    dataDir: join(root, "state"),
    source: { kind: "cli" },
    defaultBinding: true,
  });
  ({ service } = await host.ensureProject(randomUUID(), "terminal-project", {
    workspace,
    cwd: workspace,
    configHome: user,
    configPath: config,
    homedir: user,
    deploymentPath: deployment,
    environment: { PATH: process.env.PATH },
    credentialNames: [],
    options: {
      workspace,
      data_dir: join(root, "state"),
      scratch,
      allow_write: true,
      allow_network: false,
      allow_concurrent_writes: true,
      read_only_path: [],
      task_credential_command: [],
      no_deployment_mcp: false,
      sandbox_profile: "native",
    },
  }));
  observer = await connect(service.endpoint, service.authFile);
  assert.equal((await observer.call("areal/capabilities")).features.connectionProcesses, true);
  const auth = JSON.parse(await readFile(service.authFile, "utf8"));
  const descriptor = {
    projectId: "terminal-project",
    serviceId: service.serviceId,
    generation: service.generation,
    endpoint: service.endpoint,
    token: auth.principals[0].token,
  };
  const a = terminalOwner(descriptor);
  const b = terminalOwner(descriptor);
  const thread = (
    await observer.call("areal/thread/start", {
      requestId: randomUUID(),
      cwd: workspace,
      agentProfile: { id: "terminal", revision: "v1" },
    })
  ).thread.id;
  const legacy = (
    await observer.call("areal/thread/start", {
      requestId: randomUUID(),
      cwd: workspace,
      agentProfile: { id: "legacy", revision: "v1" },
    })
  ).thread.id;
  const request = {
    threadId: thread,
    lifetime: "connection",
    argv: ["/bin/sh"],
    cwd: ".",
    tty: true,
    cols: 80,
    rows: 24,
    timeoutMs: 30000,
  };
  await assert.rejects(
    a.request("areal/process/start", { ...request, threadId: legacy, requestId: randomUUID() }),
    /profile.*connection/i,
  );
  assert.deepEqual((await observer.call("areal/process/list", { threadId: legacy })).data, []);
  checks.push("legacy-profile-does-not-gain-connection-process-permission");

  const originalId = randomUUID();
  const first = await a.request("areal/process/start", { ...request, requestId: originalId });
  const second = await b.request("areal/process/start", { ...request, requestId: randomUUID() });
  const ordinary = await observer.call("areal/process/start", {
    ...request,
    lifetime: "thread",
    requestId: randomUUID(),
  });
  await a.request("areal/process/write", {
    threadId: thread,
    id: first.id,
    requestId: randomUUID(),
    dataBase64: Buffer.from("printf connection-terminal-; printf 'ready\\n'\n").toString("base64"),
  });
  await a.request("areal/process/resize", {
    threadId: thread,
    id: first.id,
    requestId: randomUUID(),
    cols: 100,
    rows: 30,
  });
  let text = "";
  let cursor;
  await until(async () => {
    const output = await a.request("areal/process/read", {
      threadId: thread,
      id: first.id,
      ...(cursor ? { after: cursor } : {}),
      maxBytes: 4096,
      waitMs: 1000,
    });
    for (const chunk of output.chunks)
      text += Buffer.from(chunk.dataBase64, "base64").toString("utf8");
    cursor = output.nextCursor;
    return text.includes("connection-terminal-ready");
  }, "terminal receives output on its Main-owned connection");
  const active = (await observer.call("areal/process/list", { threadId: thread })).data;
  const firstRecord = active.find((process) => process.id === first.id);
  const secondRecord = active.find((process) => process.id === second.id);
  assert.ok(firstRecord.connectionId);
  assert.ok(secondRecord.connectionId);
  assert.notEqual(firstRecord.connectionId, secondRecord.connectionId);
  assert.equal(active.find((process) => process.id === ordinary.id).connectionId, undefined);
  checks.push("dedicated-main-connections-start-read-write-resize-real-ptys");

  a.child.kill("SIGKILL");
  assert.equal((await a.exited).signal, "SIGKILL");
  await until(async () => {
    const processes = (await observer.call("areal/process/list", { threadId: thread })).data;
    return processes.find((process) => process.id === first.id).cleanupConfirmed;
  }, "killed terminal owner releases its Runtime scope");
  const afterKill = (await observer.call("areal/process/list", { threadId: thread })).data;
  assert.equal(afterKill.find((process) => process.id === second.id).cleanupConfirmed, false);
  assert.equal(afterKill.find((process) => process.id === ordinary.id).cleanupConfirmed, false);
  assert.equal((await host.status()).projects[0].service.generation, service.generation);
  checks.push("main-owner-sigkill-cleans-only-its-process-without-stopping-core");

  const receipt = await b.request("areal/request/read", {
    threadId: thread,
    requestId: originalId,
  });
  assert.equal(receipt.data.find((entry) => entry.requestId === originalId).result.id, first.id);
  checks.push("lost-owner-original-request-recovery-keeps-same-process-identity");
  await b.close();
  assert.equal((await b.exited).code, 0);
  await until(async () => {
    const processes = (await observer.call("areal/process/list", { threadId: thread })).data;
    return processes.find((process) => process.id === second.id).cleanupConfirmed;
  }, "graceful terminal owner disconnect releases its Runtime scope");
  assert.equal(
    (await observer.call("areal/process/list", { threadId: thread })).data.find(
      (process) => process.id === ordinary.id,
    ).cleanupConfirmed,
    false,
  );
  await observer.call("areal/process/terminate", {
    threadId: thread,
    id: ordinary.id,
    requestId: randomUUID(),
  });
  checks.push("graceful-disconnect-preserves-ordinary-thread-resource");
  const stopped = await host.request("host.stop", {
    requestId: randomUUID(),
    expectedGeneration: host.generation,
    strategy: "ifIdle",
  });
  assert.equal(stopped.state, "completed");
  const result = {
    root,
    binary,
    binarySha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    checks,
    owners: owners.map(({ child }) => ({
      pid: child.pid,
      code: child.exitCode,
      signal: child.signalCode,
    })),
    excluded: [
      "Electron UI and quit",
      "Desktop command journal bridge",
      "real provider",
      "package",
    ],
  };
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const owner of owners) {
    if (owner.child.exitCode === null && owner.child.signalCode === null)
      owner.child.kill("SIGKILL");
    await owner.exited;
  }
  observer?.socket.close();
  try {
    if (host.socket && !host.socket.destroyed) {
      const result = await host.request("host.stop", {
        requestId: randomUUID(),
        expectedGeneration: host.generation,
        strategy: "cancel",
      });
      assert.equal(result.state, "completed");
    }
  } finally {
    host.close();
  }
}
