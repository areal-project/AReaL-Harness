import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { trackedMkdtemp } from "../clients/gui/scripts/support/host-cleanup.cjs";
import { join, resolve } from "node:path";
import { connect } from "../examples/desktop-api/client.mjs";
import {
  createIdentity,
  identityId,
  secureChannel,
} from "../clients/gui/packages/remote/src/channel.mjs";
import { createRemoteWire } from "../clients/gui/packages/remote/src/wire.mjs";
import { certificates, relayFixture } from "../clients/gui/scripts/remote-relay-fixture.mjs";
import { respondToSessionName } from "./model-fixture.mjs";

assert.equal(
  process.env.AREAL_TEST_HOST_KEYCHAIN,
  "1",
  "Requires isolated synthetic vault authorization",
);
const repository = await realpath(new URL("..", import.meta.url).pathname);
const require = createRequire(join(repository, "clients/gui/app/package.json"));
const { HostClient } = require("@areal/client/node");
const { GuiHostProjects } = require("../app/src/core/gui-host-projects.cjs");
const { HostRemote } = require("../app/src/core/host-remote.cjs");
const { NativeRemote } = require("../app/src/core/native-remote.cjs");
const WebSocket = require("ws");
const root = await realpath(await trackedMkdtemp("/tmp/ah-host-remote-"));
const home = join(root, "host"),
  user = join(root, "user"),
  workspace = join(root, "workspace");
const binary = resolve(
  process.env.AREAL_CORE_BIN ?? join(repository, ".local/shared-host-bin/areal"),
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const evidence = {
  root,
  binary,
  binarySha256: hash(await readFile(binary)),
  scriptSha256: hash(await readFile(new URL(import.meta.url))),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repository }).trim(),
  checks: [],
  cleanup: [],
  excluded: ["Electron GUI exit", "physical phone", "real provider", "installed package"],
};
const host = new HostClient();
const source = new GuiHostProjects({
  binary,
  home,
  singletonHeld: true,
  source: {
    profile: join(root, "profile"),
    coreHome: join(root, "gui-core"),
    legacyServiceHome: join(root, "legacy"),
  },
  encryption: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "fixture",
    encryptString: (v) => Buffer.from(v),
    decryptString: (v) => v.toString("utf8"),
  },
});
const actions = [];
let core,
  storage,
  native,
  directSocket,
  directSecure,
  directRpc,
  secure,
  socket,
  hostChild,
  hostIdentity,
  failure,
  modelFailure;
const modelRequests = [];
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    assert.equal(body.stream, true);
    const tools = (body.messages ?? []).filter((m) => m.role === "tool");
    assert.ok(tools.length <= 1, "one filesystem result");
    modelRequests.push({ stage: tools.length ? "completion" : "approval" });
    assert.ok(modelRequests.length <= 2, "no provider replay");
    const delta = tools.length
      ? { content: "HOST_REMOTE_ORIGINAL_TURN_DONE" }
      : {
          tool_calls: [
            {
              index: 0,
              id: "host-remote-write",
              type: "function",
              function: {
                name: "fs_create",
                arguments: JSON.stringify({ path: "approved.txt", text: "approved once" }),
              },
            },
          ],
        };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tools.length ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
    );
  } catch (error) {
    modelFailure = error;
    response.destroy(error);
  }
});
async function until(read, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (modelFailure) throw modelFailure;
    const result = await read();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timeout: ${label}`);
}
async function exited(pid) {
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
  }, `owned process ${pid} exit`);
}
async function enrolled(origin, code, ca) {
  return new Promise((done, reject) => {
    const request = httpsRequest(
      `${origin}/enroll`,
      { method: "POST", ca, headers: { "content-type": "application/json" } },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => (raw += chunk));
        response.on("end", () => {
          try {
            assert.equal(response.statusCode, 201, raw);
            done(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify({ code }));
  });
}
try {
  for (const directory of [home, user, workspace, join(root, "scratch")])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  const configPath = join(root, "config.toml"),
    deploymentPath = join(root, "deployment.json");
  await writeFile(
    configPath,
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
  );
  await writeFile(
    deploymentPath,
    JSON.stringify({
      profiles: [
        {
          id: "approval",
          revision: "v1",
          displayName: "Fixture approval",
          instructions: "Complete the requested tool, then finish.",
          approvalTools: ["fs_create"],
        },
      ],
    }),
  );
  const tlsHome = await certificates();
  const relay = await relayFixture({ after: (action) => actions.push(action) }, { tlsHome });
  evidence.relay = relay.resources;
  const ca = await readFile(join(tlsHome, "ca.pem"));
  const registration = await enrolled(relay.origin, relay.admin("enrollment").code, ca);
  const log = await open(join(home, "host.log"), "a", 0o600);
  hostChild = spawn(binary, ["host", "run"], {
    env: {
      ...process.env,
      AREAL_HARNESS_HOME: home,
      AREAL_HARNESS_SERVICE_HOME: home,
      SSL_CERT_FILE: join(tlsHome, "ca.pem"),
    },
    stdio: ["ignore", "ignore", log.fd],
  });
  await log.close();
  await until(async () => {
    assert.equal(hostChild.exitCode, null, "owned Host startup must remain alive");
    try {
      await host.connect(home);
      return true;
    } catch {
      host.close();
      return false;
    }
  }, "owned native Host startup");
  hostIdentity = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
  evidence.host = hostIdentity;
  const projectId = randomUUID(),
    alias = hash(`host:${projectId}`).slice(0, 24),
    dataDir = join(root, "state");
  await host.registerProject(randomUUID(), {
    projectId,
    workspace,
    dataDir,
    source: { kind: "cli" },
    defaultBinding: false,
  });
  const ensured = await host.ensureProject(randomUUID(), projectId, {
    workspace,
    cwd: workspace,
    configHome: user,
    homedir: user,
    configPath,
    deploymentPath,
    environment: { PATH: process.env.PATH, NO_PROXY: "127.0.0.1,localhost" },
    credentialNames: [],
    options: {
      workspace,
      data_dir: dataDir,
      scratch: join(root, "scratch"),
      allow_write: true,
      allow_network: false,
      allow_concurrent_writes: false,
      read_only_path: [],
      task_credential_command: [],
      no_deployment_mcp: false,
      sandbox_profile: "native",
    },
  });
  evidence.service = ensured.service;
  core = await connect(ensured.service.endpoint, ensured.service.authFile);
  await source.init();
  const device = await createIdentity(),
    identity = await createIdentity();
  const backend = {
    host: source,
    home: source.source.coreHome,
    save: (name, value) =>
      writeFile(join(source.source.coreHome, name), JSON.stringify(value), { mode: 0o600 }),
  };
  storage = new HostRemote(backend, () => {});
  await storage.init();
  await storage.replace({
    schemaVersion: 2,
    identity,
    enabled: true,
    directEnabled: false,
    relay: relay.origin,
    relayProtocol: "areal.remote.v2",
    ...registration,
    devices: [],
    deviceGrants: [
      {
        devicePeerId: identityId(device),
        displayName: "Original fixture device",
        projectIds: [alias],
        capabilities: ["observe", "answer", "review"],
        revision: 1,
        status: "active",
        pairedAt: Date.now(),
      },
    ],
  });
  const before = await host.request("remote.read", {});
  await storage.drained();
  storage.close();
  storage = null;
  let stateEvents = 0;
  native = new NativeRemote({ backend, schedule: () => stateEvents++ });
  await native.init();
  evidence.handoff = JSON.parse(await readFile(join(home, "host/remote-gateway.json"), "utf8"));
  assert.equal(evidence.handoff.sourceId, before.sourceId);
  assert.equal(evidence.handoff.revision, before.revision);
  assert.equal(evidence.handoff.state, "completed");
  await until(() => native.state().connected, "native Relay ready through Main subscription");
  await native.control({ operation: "enableDirect" });
  const directState = native.state();
  evidence.direct = { origin: directState.directUrl, hostId: directState.directHostId };
  assert.match(directState.directUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(directState.directHostId, identityId(identity));
  const health = await fetch(`${directState.directUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ready" });
  assert.equal((await fetch(`${directState.directUrl}/remote.html`)).status, 200);
  assert.equal((await fetch(`${directState.directUrl}/index.html`)).status, 404);
  const invitation = await native.control({ operation: "pair", transport: "direct" });
  const pairingDevice = await createIdentity();
  directSocket = new WebSocket(directState.directUrl.replace("http:", "ws:") + "/remote/socket", {
    origin: directState.directUrl,
  });
  const directWire = createRemoteWire(directSocket);
  await directWire.ready;
  directSecure = await secureChannel(directWire.wire, pairingDevice, identityId(identity));
  const directMessages = directSecure.messages();
  await directSecure.send({
    method: "hello",
    apiVersion: "areal.remote.v2",
    clientVersion: "host-production-smoke",
    displayName: "Native Direct pairing",
    inviteSecret: new URLSearchParams(new URL(invitation.payload).hash.slice(1)).get("invite"),
  });
  assert.equal((await directMessages.next()).value.event, "pairing");
  await until(
    () => native.state().pending.some((pair) => pair.id === identityId(pairingDevice)),
    "Host pending notification reaches unchanged Main consumer",
  );
  await native.control({
    operation: "approve",
    id: identityId(pairingDevice),
    projects: [alias],
    preset: "Observer",
  });
  assert.equal((await directMessages.next()).value.event, "ready");
  let directSequence = 0;
  directRpc = async (method, params) => {
    const id = String(++directSequence);
    await directSecure.send({ id, method, context: { projectId: alias }, params });
    const reply = await directMessages.next();
    assert.equal(reply.done, false);
    assert.equal(reply.value.id, id);
    assert.equal(reply.value.error, undefined, JSON.stringify(reply.value.error));
    return reply.value.result;
  };
  assert.ok(
    (await directRpc("project.list", {})).projects.some((project) => project.projectId === alias),
  );
  evidence.checks.push({
    name: "native Direct assets and one-use pairing with Main push state",
    passed: true,
    stateEvents,
  });
  await native.close();
  native = null;
  source.close();
  const original = await core.call("areal/thread/start", {
    requestId: randomUUID(),
    cwd: workspace,
    agentProfile: { id: "approval", revision: "v1" },
  });
  const sourceThread = await core.call("areal/thread/start", {
    requestId: randomUUID(),
    cwd: workspace,
  });
  const anchor = await core.call("areal/thread/start", { requestId: randomUUID(), cwd: workspace });
  const task = await core.call("areal/task/create", {
    requestId: randomUUID(),
    sourceThreadId: sourceThread.thread.id,
    threadId: anchor.thread.id,
    mode: "scheduled",
    objective: "HOST_REMOTE_PAUSED_TASK",
    interactionMode: "interactive",
    scheduleV2: {
      version: 1,
      rule: {
        kind: "onceIso",
        atIso: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
      misfire: { kind: "coalesce" },
      overlap: "skip",
    },
  });
  await core.call("areal/task/pause", {
    requestId: randomUUID(),
    taskId: task.id,
    expectedRevision: task.revision,
  });
  const threadId = original.thread.id;
  const started = await core.call("areal/turn/start", {
    requestId: randomUUID(),
    threadId,
    input: [{ type: "text", text: "Create approved.txt with approved once, then finish." }],
    expectedConfigRevision: 1,
  });
  const turnId = started.turn.id;
  const interaction = await until(
    async () =>
      (await core.call("areal/interaction/list", { threadId })).data.find(
        (item) => item.turnId === turnId && item.status === "pending",
      ),
    "original native approval",
  );
  await core.close();
  core = null;
  socket = new WebSocket(relay.origin.replace("https:", "wss:") + "/remote/socket", {
    origin: relay.origin,
    ca,
  });
  const { wire, ready: wireReady } = createRemoteWire(socket, { room: registration.room });
  await wireReady;
  secure = await secureChannel(wire, device, identityId(identity));
  const messages = secure.messages();
  await secure.send({
    method: "hello",
    apiVersion: "areal.remote.v2",
    clientVersion: "host-production-smoke",
    displayName: "Existing JS client",
  });
  const ready = (await messages.next()).value;
  assert.equal(ready.event, "ready");
  let sequence = 0;
  async function rpc(method, params, commandId) {
    const id = String(++sequence);
    await secure.send({
      id,
      method,
      context: {
        projectId: alias,
        ...(commandId
          ? {
              gatewayGeneration: ready.gatewayGeneration,
              grantRevision: ready.grantRevision,
              serviceGeneration: ensured.service.generation,
            }
          : {}),
      },
      params,
      ...(commandId ? { commandId } : {}),
    });
    const next = await messages.next();
    assert.equal(next.done, false);
    assert.equal(next.value.id, id);
    assert.equal(next.value.error, undefined, JSON.stringify(next.value.error));
    return next.value.result;
  }
  const readTask = await rpc("task.read", { taskId: task.id });
  assert.equal(readTask.taskId, task.id);
  assert.equal(readTask.taskPaused, true);
  const directTask = await directRpc("task.read", { taskId: task.id });
  assert.equal(directTask.taskId, task.id);
  assert.equal(directTask.taskPaused, true);
  evidence.checks.push({
    name: "native Direct reads paused Task after Main facade closes",
    passed: true,
  });
  evidence.checks.push({
    name: "native Relay reads paused Task without active scheduling",
    passed: true,
  });
  const target = { threadId, turnId, interactionId: interaction.requestId };
  let detail = await rpc("attention.read", target),
    body = detail.review.chunk;
  while (detail.nextCursor) {
    detail = await rpc("attention.read", { ...target, cursor: detail.nextCursor });
    body += detail.review.chunk;
  }
  assert.equal(detail.complete, true);
  assert.ok(detail.reviewToken);
  assert.deepEqual(JSON.parse(body).effectiveArguments, interaction.effectiveArguments);
  const commandId = randomUUID();
  const accepted = await rpc(
    "interaction.respond",
    {
      ...target,
      argumentsDigest: interaction.argumentsDigest,
      decision: "allowOnce",
      reviewToken: detail.reviewToken,
    },
    commandId,
  );
  assert.equal(accepted.admissionState, "accepted");
  evidence.checks.push({
    name: "native Relay fully reviewed approval admitted",
    commandId,
    operationId: accepted.operationId,
    passed: true,
  });
  const completed = await until(async () => {
    let page = await rpc("review.read", { threadId, turnId }),
      text = page.review.chunk;
    while (page.nextCursor) {
      page = await rpc("review.read", { threadId, turnId, cursor: page.nextCursor });
      text += page.review.chunk;
    }
    const value = JSON.parse(text);
    return value.turnStatus === "completed" && value;
  }, "original Core result via native Relay");
  assert.ok(completed.result.some((item) => item.text.includes("HOST_REMOTE_ORIGINAL_TURN_DONE")));
  assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), "approved once");
  assert.deepEqual(
    modelRequests.map((row) => row.stage),
    ["approval", "completion"],
  );
  const receipt = await rpc("command.read", { commandId });
  assert.equal(receipt.operationId, accepted.operationId);
  assert.equal(receipt.admissionState, "accepted");
  const controlId = randomUUID();
  const control = {
    operation: "renameDevice",
    id: identityId(device),
    name: "Native fixture device",
  };
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(control).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
  const intentDigest = host.intentDigest(
    "remote.gateway.control",
    before.sourceId,
    controlId,
    canonical,
  );
  await host.request("remote.gateway.control", {
    requestId: controlId,
    expectedGeneration: host.generation,
    sourceId: before.sourceId,
    request: control,
  });
  const originalControl = (await host.operation(controlId)).operation;
  assert.equal(
    originalControl.controlDigest,
    intentDigest,
    "Host and Main use the same keyed intent bytes",
  );
  assert.notEqual(
    intentDigest,
    hash(canonical),
    "operation intent is not an ordinary hash of request values",
  );
  assert.equal((await rpc("command.read", { commandId })).operationId, accepted.operationId);
  evidence.intentPrivacy = {
    requestId: controlId,
    keyedDigestMatched: true,
    originalAssociationRetained: true,
  };
  evidence.checks.push({
    name: "actual Runtime side effect and original Core result once after legacy clients close",
    passed: true,
  });
} catch (error) {
  failure = error.stack;
} finally {
  await core?.close().catch((error) => (failure ??= error.stack));
  secure?.close();
  socket?.terminate();
  directSecure?.close();
  directSocket?.terminate();
  await native?.close().catch((error) => (failure ??= error.stack));
  await storage?.drained().catch((error) => (failure ??= error.stack));
  storage?.close();
  source.close();
  if (hostIdentity) {
    const reference = { requestId: randomUUID(), generation: host.generation, hostId: host.hostId };
    evidence.cleanup.push({ kind: "Host stop", reference });
    try {
      const receipt = await host.stop(reference.requestId, reference.generation, "cancel");
      evidence.cleanup.at(-1).receipt = receipt;
      assert.equal(receipt.state, "completed");
      await exited(hostIdentity.pid);
    } catch (error) {
      evidence.cleanup.at(-1).error = { code: error.code, message: error.message };
      failure ??= error.stack;
    }
  }
  host.close();
  for (const action of actions.reverse())
    await action().catch((error) => (failure ??= error.stack));
  if (process.platform === "darwin") {
    const service = `org.areal.host.v1.${hash(home)}`;
    for (const directory of ["vault-operations", "remote-operations"]) {
      for (const file of await readdir(join(home, "host", directory)).catch((error) =>
        error.code === "ENOENT" ? [] : Promise.reject(error),
      )) {
        const receipt = JSON.parse(await readFile(join(home, "host", directory, file), "utf8"));
        assert.equal(file, `${receipt.requestId}.json`);
        if (!["vault.replace", "remote.replace"].includes(receipt.method) || !receipt.entryId)
          continue;
        const remove = spawnSync(
          "security",
          ["delete-generic-password", "-s", service, "-a", receipt.entryId],
          { encoding: "utf8" },
        );
        const absent = spawnSync(
          "security",
          ["find-generic-password", "-s", service, "-a", receipt.entryId],
          { encoding: "utf8" },
        );
        assert.equal(absent.status, 44, "exact synthetic vault item absent");
        evidence.cleanup.push({
          kind: "synthetic vault item",
          entryId: receipt.entryId,
          removeStatus: remove.status,
          absent: true,
        });
      }
    }
  }
  model.closeAllConnections();
  await new Promise((done) => model.close(done));
  evidence.modelRequests = modelRequests;
  evidence.failure = failure;
  evidence.passed =
    !failure && evidence.checks.length === 5 && evidence.checks.every((check) => check.passed);
  await writeFile(join(root, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify(
      { passed: evidence.passed, evidence: join(root, "result.json"), failure },
      null,
      2,
    ),
  );
  if (!evidence.passed) process.exitCode = 1;
}
