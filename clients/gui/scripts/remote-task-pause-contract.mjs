// RC09 生产 Gateway/只读观察/持久日志的 fixture；原生行为单独由 T30/T31 验证。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { makeTempDir } from "./support/temp.mjs";
import { join } from "node:path";
import { taskContractHost, taskContractProject as PROJECT } from "./remote-task-contract-host.mjs";
const require = createRequire(import.meta.url);
const { TaskQuestions } = require("@areal/workbench-service/desktop/core/remote-task-questions.cjs");
const { SessionObservers } = require("@areal/workbench-service/desktop/core/remote-session-observer.cjs");
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { sessionCommand } = require("@areal/workbench-service/desktop/core/remote-session-commands.cjs");
const { RemotePush } = require("@areal/workbench-service/desktop/core/remote-push.cjs");
const home = await makeTempDir("rc09-contract-");
const checks = [];
const owner = await taskContractHost();
async function fixture(name) {
  const root = join(home, name);
  await mkdir(root);
  const backend = new CoreBackend({ home: root, binary: "/unused", onChange() {} });
  backend.saved = [{ id: PROJECT, root }];
  const storage = await owner.register(backend, root);
  const project = await backend.loadProjectJournal(PROJECT);
  project.service = { generation: "g", serviceId: "s" };
  project.endpoint = "ws://fixture";
  project.token = "fixture";
  project.model.connection(true);
  const task = {
    id: "task",
    revision: 7,
    paused: false,
    cancelled: false,
    runs: [{ id: "run", status: "running", workers: [] }],
  };
  const calls = [],
    reads = [];
  let afterRead,
    beforeReply,
    response,
    outcomeLoss = false;
  const client = (project.client = {
    ready: true,
    capabilities: {
      features: {
        atomicObserve: true,
        atomicObserveOwnership: true,
        subscriptionRemoval: true,
        taskPauseRunGuard: true,
      },
      methods: ["areal/task/read", "areal/channel/read", "areal/channel/reply", "areal/task/pause"],
    },
    onClose: () => () => {},
    request: async (method, params) => {
      calls.push({ method, params: structuredClone(params) });
      assert.equal(method, "areal/task/pause");
      await beforeReply?.(params);
      if (
        params.taskId !== task.id ||
        params.expectedRunId !== task.runs.at(-1)?.id ||
        params.expectedRevision !== task.revision
      )
        throw Object.assign(new Error("native conflict"), { code: -32009 });
      task.paused = true;
      task.revision++;
      if (outcomeLoss) throw Object.assign(new Error("lost response"), { submissionUnknown: true });
      return response ?? structuredClone(task);
    },
  });
  const remote = {
    backend,
    gatewayGeneration: "gw",
    crypto: { identityId: () => "h" },
    config: {
      identity: {},
      deviceGrants: ["a", "b"].map((devicePeerId) => ({
        devicePeerId,
        status: "active",
        revision: 1,
        projectIds: [PROJECT],
        capabilities: ["observe", "pauseTask"],
      })),
    },
  };
  remote.push = new RemotePush(remote);
  const connection = {
    peer: "a",
    connectionId: "c",
    grantRevision: 1,
    gatewayGeneration: "gw",
    alive: () => true,
    send() {},
    close() {},
  };
  const observers = new SessionObservers(remote);
  observers.connect = async (entry) => {
    entry.client = {
      closed: false,
      close() {},
      request: async (method, params, options) => {
        reads.push({ method, params: structuredClone(params) });
        let result;
        if (method === "areal/task/read") result = structuredClone(task);
        else throw new Error(`Unexpected native read: ${method}`);
        await afterRead?.(method, params);
        options?.onResult?.(result);
        return result;
      },
    };
  };
  const questions = new TaskQuestions(observers);
  const target = () => ({ taskId: task.id, runId: "run" });
  const read = (params = target(), conn = connection) =>
    questions.pauseRead(conn, PROJECT, params, (x) => x);
  const request = (
    params = { taskId: task.id, expectedRunId: "run", expectedRevision: 7 },
    commandId = randomUUID(),
  ) => ({
    id: randomUUID(),
    method: "task.pause",
    commandId,
    context: {
      projectId: PROJECT,
      gatewayGeneration: "gw",
      grantRevision: 1,
      serviceGeneration: "g",
    },
    params,
  });
  const run = (req, conn = connection) =>
    sessionCommand(
      remote,
      conn,
      req,
      (x) => x,
      observers.admission.bind(observers),
      undefined,
      questions,
    );
  const commandRead = (commandId, conn = connection) =>
    run({ method: "command.read", context: { projectId: PROJECT }, params: { commandId } }, conn);
  return {
    ...storage,
    backend,
    project,
    client,
    remote,
    connection,
    observers,
    questions,
    task,
    calls,
    reads,
    target,
    read,
    request,
    run,
    commandRead,
    set afterRead(v) {
      afterRead = v;
    },
    set beforeReply(v) {
      beforeReply = v;
    },
    set response(v) {
      response = v;
    },
    set outcomeLoss(v) {
      outcomeLoss = v;
    },
  };
}
async function check(name, test) {
  const f = await fixture(name);
  try {
    await test(f);
    checks.push(name);
  } finally {
    f.observers.close();
    f.remote.push.close();
  }
}
try {
  await check("pause-original-current-run-durable-receipt", async (f) => {
    const req = f.request(),
      value = await f.run(req);
    assert.equal(value.admissionState, "accepted");
    assert.deepEqual(value.receipt, { taskId: "task", runId: "run", revision: 8, paused: true });
    assert.equal(f.calls[0].params.requestId, value.operationId);
    const restarted = new CoreBackend({ home: f.backend.home, binary: "/unused", onChange() {} });
    restarted.saved = f.backend.saved;
    restarted.host = f.backend.host;
    const restored = await restarted.loadProjectJournal(PROJECT);
    assert.equal(restored.pending.length, 0);
    const saved = await restarted.readRemoteRecord(restored, {
      hostId: "h",
      devicePeerId: "a",
      projectId: PROJECT,
      commandId: req.commandId,
    });
    assert.deepEqual(saved.receipt, value.receipt);
    f.task.runs.push({ id: "new", status: "queued", workers: [] });
    delete f.client.capabilities.features.taskPauseRunGuard;
    assert.equal((await f.run(req)).admissionState, "accepted");
    assert.equal(f.calls.length, 1);
    assert.equal(
      (
        await f.run({
          ...req,
          params: { expectedRevision: 7, expectedRunId: "run", taskId: "task" },
        })
      ).admissionState,
      "accepted",
    );
    await assert.rejects(f.run({ ...req, params: { ...req.params, expectedRunId: "new" } }), {
      code: "COMMAND_CONFLICT",
    });
  });
  await check("current-target-revision-capability-and-no-first-run", async (f) => {
    const detail = await f.read();
    assert.equal(detail.available, true);
    assert.equal(detail.revision, 7);
    f.task.runs.unshift({ id: "old", status: "completed", workers: [] });
    assert.equal((await f.read({ taskId: "task", runId: "old" })).available, false);
    await assert.rejects(
      f.run(f.request({ taskId: "task", expectedRunId: "old", expectedRevision: 7 })),
      { code: "TARGET_CHANGED" },
    );
    await assert.rejects(f.run(f.request({ ...f.request().params, expectedRevision: 6 })), {
      code: "TARGET_CHANGED",
    });
    for (const missing of ["feature", "method"]) {
      const saved = structuredClone(f.client.capabilities);
      if (missing === "feature") delete f.client.capabilities.features.taskPauseRunGuard;
      else
        f.client.capabilities.methods = f.client.capabilities.methods.filter(
          (x) => x !== "areal/task/pause",
        );
      assert.equal((await f.read()).available, false);
      await assert.rejects(f.run(f.request()), { code: "CORE_INCOMPATIBLE" });
      f.client.capabilities = saved;
    }
    f.task.runs = [];
    assert.equal((await f.read({ taskId: "task" })).available, false);
    await assert.rejects(f.run(f.request({ ...f.request().params, expectedRunId: undefined })), {
      code: "INVALID_PARAMS",
    });
    assert.equal(f.calls.length, 0);
  });
  await check("unknown-observation-and-worker-settlement-are-independent", async (f) => {
    f.outcomeLoss = true;
    f.task.runs[0].workers = [{ settled: false, status: "running" }];
    const req = f.request(),
      value = await f.run(req);
    assert.equal(value.admissionState, "unknown");
    assert.equal(value.observedState.taskPaused, true);
    assert.equal(value.observedState.provesCommandAdmission, false);
    assert.equal(value.observedState.settled, false);
    f.task.runs[0].status = "completed";
    assert.equal((await f.commandRead(req.commandId)).observedState.settled, false);
    f.task.runs[0].status = "paused";
    f.task.runs[0].reason = "serverRestarted";
    f.task.runs[0].workers[0].settled = true;
    const observed = await f.commandRead(req.commandId);
    assert.equal(observed.admissionState, "unknown");
    assert.equal(observed.observedState.settled, true);
    assert.equal(observed.observedState.runStatus, "paused");
    assert.equal((await f.run(req)).admissionState, "unknown");
    assert.equal(f.calls.length, 1);
    assert.ok(f.reads.every((x) => x.method === "areal/task/read"));
  });
  await check("queued-new-run-race-rejects-original-target", async (f) => {
    f.beforeReply = () => f.task.runs.push({ id: "new", status: "queued", workers: [] });
    const result = await f.run(f.request());
    assert.equal(result.admissionState, "rejected");
    assert.equal(result.error.code, "TARGET_CHANGED");
    assert.equal(f.calls[0].params.expectedRunId, "run");
    assert.equal(f.task.paused, false);
  });
  await check("current-grant-required-at-admission-and-publication", async (f) => {
    f.remote.config.deviceGrants[0].capabilities = ["observe"];
    await assert.rejects(f.run(f.request()), { code: "FORBIDDEN" });
    assert.equal(f.calls.length, 0);
    f.remote.config.deviceGrants[0].capabilities.push("pauseTask");
    f.afterRead = () => {
      f.remote.config.deviceGrants[0].status = "revoked";
    };
    await assert.rejects(f.run(f.request()), { code: "GRANT_CHANGED" });
    assert.equal(f.calls.length, 0);
  });
  await check("durable-write-failure-does-not-infer-admission", async (f) => {
    f.failJournal("outcome");
    const req = f.request(),
      value = await f.run(req);
    assert.equal(value.admissionState, "unknown");
    assert.equal(value.observedState.taskPaused, true);
    assert.equal(f.project.pending.length, 1);
    assert.equal((await f.commandRead(req.commandId)).admissionState, "unknown");
    assert.equal(f.calls.length, 1);
  });

  await check("revoked-publication-keeps-durable-known-receipt", async (f) => {
    const req = f.request();
    f.beforeReply = () => {
      f.remote.config.deviceGrants[0].status = "revoked";
    };
    await assert.rejects(f.run(req), { code: "GRANT_CHANGED" });
    assert.equal(f.calls.length, 1);
    f.remote.config.deviceGrants[0].status = "active";
    assert.equal((await f.commandRead(req.commandId)).admissionState, "accepted");
    assert.equal(f.calls.length, 1);
  });
  await check("actual-noise-direct-pause-route-and-schema", async (f) => {
    const crypto = await import("../packages/remote/src/channel.mjs");
    const { once } = await import("node:events");
    const WebSocket = require("../app/node_modules/ws");
    const { startDirect } = require("@areal/workbench-service/desktop/core/remote-direct.cjs");
    const device = await crypto.createIdentity();
    f.remote.crypto = crypto;
    f.remote.config.identity = await crypto.createIdentity();
    f.remote.config.directEnabled = true;
    f.remote.config.deviceGrants[0].devicePeerId = crypto.identityId(device);
    const original = SessionObservers.prototype.connect;
    SessionObservers.prototype.connect = f.observers.connect;
    f.remote.sessions =
      new (require("@areal/workbench-service/desktop/core/remote-session-acceptor.cjs").SessionAcceptor)(f.remote);
    const direct = await startDirect(f.remote);
    let secure;
    try {
      const socket = new WebSocket(direct.ws, { origin: direct.origin });
      await once(socket, "open");
      const wire = crypto.byteChannel(
        (bytes) => socket.send(bytes),
        () => socket.close(),
      );
      socket.on("message", (bytes) => wire.receive(bytes));
      socket.on("close", () => wire.close());
      secure = await crypto.secureChannel(
        wire,
        device,
        crypto.identityId(f.remote.config.identity),
      );
      const messages = secure.messages();
      secure.send({
        method: "hello",
        apiVersion: "areal.remote.v2",
        clientVersion: "rc09-fixture",
        displayName: "fixture",
      });
      const ready = (await messages.next()).value;
      assert.ok(ready.methods.includes("task.read"));
      assert.ok(ready.methods.includes("task.pause"));
      assert.ok(!ready.methods.includes("task.reply"));
      secure.send({
        id: "detail",
        method: "task.read",
        context: { projectId: PROJECT },
        params: f.target(),
      });
      const detail = (await messages.next()).value.result;
      assert.equal(detail.available, true);
      assert.equal(detail.revision, 7);
      assert.equal(detail.reviewToken, undefined);
      const req = f.request();
      secure.send(req);
      const value = (await messages.next()).value.result;
      assert.equal(value.admissionState, "accepted");
      assert.equal(value.receipt.taskId, "task");
      assert.equal(value.observedState.taskPaused, true);
      assert.equal(value.nativeRequestId, f.calls[0].params.requestId);
      secure.send({ ...req, id: "duplicate" });
      assert.equal((await messages.next()).value.result.operationId, value.operationId);
      secure.send({ ...req, id: "alias", method: "task.reply" });
      assert.equal((await messages.next()).value.error.code, "INVALID_PARAMS");
      secure.send({
        id: "injected",
        method: "task.read",
        context: { projectId: PROJECT },
        params: { ...f.target(), endpoint: "ws://injected" },
      });
      assert.equal((await messages.next()).value.error.code, "INVALID_PARAMS");
      assert.equal(f.calls.length, 1);
    } finally {
      secure?.close();
      direct.close();
      f.remote.sessions.close();
      SessionObservers.prototype.connect = original;
    }
  });
} finally {
  await owner.close();
}

console.log(JSON.stringify({ checks }));
