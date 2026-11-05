// RC08 生产 Gateway/只读观察/持久日志的 fixture；原生行为单独由 T28/T29 验证。
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
const home = await makeTempDir("rc08-contract-");
const checks = [];
const owner = await taskContractHost();
const defer = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
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
    revision: 1,
    paused: false,
    cancelled: false,
    runs: [{ id: "run", status: "running" }],
  };
  const item = {
    id: "question",
    runId: "run",
    kind: "question",
    sequence: 1,
    status: "pending",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    questions: [
      { id: "choice", title: "Native choice", options: ["A", "B"], allowFreeText: false },
      { id: "free", title: "Native free text", options: [], allowFreeText: true },
    ],
  };
  const calls = [],
    reads = [];
  let afterRead,
    beforeReply,
    channelPage,
    response,
    outcomeLoss = false;
  const client = (project.client = {
    ready: true,
    capabilities: {
      features: { atomicObserve: true, atomicObserveOwnership: true, subscriptionRemoval: true },
      methods: ["areal/task/read", "areal/channel/read", "areal/channel/reply"],
    },
    onClose: () => () => {},
    request: async (method, params) => {
      calls.push({ method, params: structuredClone(params) });
      assert.equal(method, "areal/channel/reply");
      await beforeReply?.(params);
      if (
        params.taskId !== task.id ||
        params.runId !== item.runId ||
        params.questionId !== item.id ||
        item.status !== "pending" ||
        task.cancelled ||
        item.expiresAt <= Date.now() / 1000
      )
        throw Object.assign(new Error("native conflict"), { code: -32009 });
      item.status = "answered";
      if (outcomeLoss) throw Object.assign(new Error("lost response"), { submissionUnknown: true });
      return (
        response ?? {
          accepted: true,
          messageId: "message",
          taskId: task.id,
          runId: item.runId,
          channelSequence: 3,
        }
      );
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
        capabilities: ["observe", "answer"],
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
        else if (method === "areal/channel/read")
          result = channelPage
            ? channelPage(params)
            : {
                taskId: task.id,
                channelSequence: 1,
                data: [structuredClone(item)],
                nextSequence: 1,
                hasMore: false,
              };
        else if (method === "areal/thread/observe")
          result = { ownership: { kind: "ordinary" }, thread: { id: params.threadId, turns: [] } };
        else {
          assert.equal(method, "areal/subscription/remove");
          result = {};
        }
        await afterRead?.(method, params);
        options?.onResult?.(result);
        return result;
      },
    };
  };
  const questions = new TaskQuestions(observers);
  const target = () => ({ taskId: task.id, runId: item.runId, questionId: item.id });
  const read = (params = target(), conn = connection) =>
    questions.read(conn, PROJECT, params, (x) => x);
  const request = (
    params = { ...target(), answers: { choice: "A", free: "exact" } },
    commandId = randomUUID(),
  ) => ({
    id: randomUUID(),
    method: "task.question.reply",
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
    item,
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
    set channelPage(v) {
      channelPage = v;
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
  await check(
    "authoritative-task-detail-preserves-foreground-session-and-original-options",
    async (f) => {
      await f.observers.open(f.connection, PROJECT, "ordinary", () => {});
      const viewer = f.observers.viewers.get("c");
      f.reads.length = 0;
      const detail = await f.read();
      assert.equal(detail.complete, true);
      assert.equal(detail.kind, "asyncQuestion");
      assert.deepEqual(detail.questions, f.item.questions);
      assert.deepEqual(
        f.reads.map((v) => v.method),
        ["areal/task/read", "areal/channel/read"],
      );
      assert.equal(f.observers.viewers.get("c"), viewer);
      assert.equal(viewer.entry.closed, false);
      assert.equal(f.calls.length, 0);
    },
  );
  await check("bounded-channel-pages-no-scan-and-incomplete-reply-fails-closed", async (f) => {
    f.channelPage = (params) => ({
      taskId: "task",
      data: [],
      hasMore: true,
      nextSequence: params.afterSequence + 1,
    });
    const detail = await f.read();
    assert.equal(detail.complete, false);
    assert.equal(detail.status, "unavailable");
    assert.equal(f.reads.filter((v) => v.method === "areal/channel/read").length, 8);
    await assert.rejects(f.run(f.request()), { code: "REVIEW_INCOMPLETE" });
    assert.equal(f.calls.length, 0);
    f.channelPage = (params) =>
      params.afterSequence
        ? { taskId: "task", data: [f.item], hasMore: false, nextSequence: 2 }
        : { taskId: "task", data: [], hasMore: true, nextSequence: 1 };
    assert.equal((await f.read()).complete, true);
  });
  await check(
    "cross-project-task-run-question-splicing-and-injected-fields-rejected",
    async (f) => {
      for (const patch of [
        { taskId: "foreign" },
        { runId: "foreign" },
        { questionId: "foreign" },
      ]) {
        await assert.rejects(f.read({ ...f.target(), ...patch }), { code: "TARGET_CHANGED" });
        await assert.rejects(f.run(f.request({ ...f.request().params, ...patch })), {
          code: "TARGET_CHANGED",
        });
      }
      const request = f.request();
      request.context.projectId = "foreign";
      await assert.rejects(f.run(request), { code: "FORBIDDEN" });
      await assert.rejects(f.read({ ...f.target(), threadId: "coordinator" }), {
        code: "INVALID_PARAMS",
      });
      await assert.rejects(f.run(f.request({ ...f.request().params, reviewToken: "invented" })), {
        code: "INVALID_PARAMS",
      });
      assert.equal(f.calls.length, 0);
    },
  );
  await check("exact-answers-utf8-budget-and-nested-snapshot", async (f) => {
    for (const answers of [
      { choice: "A" },
      { choice: "C", free: "ok" },
      { choice: "A", free: " " },
      { choice: "A", free: "ok", extra: "bad" },
      { choice: "A", free: "界".repeat(1366) },
    ])
      await assert.rejects(f.run(f.request({ ...f.target(), answers })), {
        code: "INVALID_PARAMS",
      });
    assert.equal(f.calls.length, 0);
    const held = defer(),
      entered = defer();
    let first = true;
    f.afterRead = async () => {
      if (first) {
        first = false;
        entered.resolve();
        await held.promise;
      }
    };
    const req = f.request({
        ...f.target(),
        answers: { choice: "B", free: "界".repeat(1365) + "x" },
      }),
      result = f.run(req);
    await entered.promise;
    req.params.answers.choice = "A";
    req.params.questionId = "foreign";
    held.resolve();
    assert.equal((await result).admissionState, "accepted");
    assert.equal(f.calls[0].params.answers.choice, "B");
    assert.equal(f.calls[0].params.questionId, "question");
    assert.equal(Buffer.byteLength(f.calls[0].params.answers.free), 4096);
  });
  await check("task-receipt-durable-before-pending-retirement-and-reload", async (f) => {
    f.response = {
      accepted: true,
      messageId: "message",
      taskId: "task",
      runId: "run",
      channelSequence: 3,
      thread: { id: "not-a-session-receipt" },
      turn: { id: "not-a-turn-receipt" },
    };
    const req = f.request(),
      value = await f.run(req);
    assert.equal(value.threadId, undefined);
    assert.equal(value.turnId, undefined);
    assert.equal(value.admissionState, "accepted");
    assert.equal(value.nativeRequestId, f.calls[0].params.requestId);
    assert.deepEqual(value.receipt, {
      accepted: true,
      messageId: "message",
      taskId: "task",
      runId: "run",
      channelSequence: 3,
    });
    const saved = (await f.journal.read()).snapshot.outcomes;
    assert.deepEqual(saved[value.operationId].receipt, value.receipt);
    const restarted = new CoreBackend({ home: f.backend.home, binary: "/unused", onChange() {} });
    restarted.saved = f.backend.saved;
    restarted.host = f.backend.host;
    const restored = await restarted.loadProjectJournal(PROJECT);
    assert.equal(restored.pending.length, 0);
    assert.deepEqual(
      (
        await restarted.readRemoteRecord(restored, {
          hostId: "h",
          devicePeerId: "a",
          projectId: PROJECT,
          commandId: req.commandId,
        })
      ).receipt,
      value.receipt,
    );
    assert.equal((await f.run(req)).admissionState, "accepted");
    assert.equal(f.calls.length, 1);
    await assert.rejects(
      f.run({ ...req, params: { ...req.params, answers: { choice: "B", free: "exact" } } }),
      { code: "COMMAND_CONFLICT" },
    );
    await assert.rejects(f.run({ ...req, params: { ...req.params, runId: "changed" } }), {
      code: "COMMAND_CONFLICT",
    });
  });
  await check("unknown-observation-never-infers-receipt-or-replays", async (f) => {
    f.outcomeLoss = true;
    const req = f.request(),
      value = await f.run(req);
    assert.equal(value.admissionState, "unknown");
    assert.equal(value.receipt, undefined);
    assert.equal(value.observedState.status, "answered");
    assert.equal(value.observedState.provesCommandAdmission, false);
    assert.equal((await f.commandRead(req.commandId)).admissionState, "unknown");
    assert.equal((await f.run(req)).admissionState, "unknown");
    assert.equal(f.calls.length, 1);
    assert.ok(f.reads.every((v) => ["areal/task/read", "areal/channel/read"].includes(v.method)));
    const restarted = new CoreBackend({ home: f.backend.home, binary: "/unused", onChange() {} });
    restarted.saved = f.backend.saved;
    restarted.host = f.backend.host;
    const restored = await restarted.loadProjectJournal(PROJECT);
    const saved = await restarted.readRemoteRecord(restored, {
      hostId: "h",
      devicePeerId: "a",
      projectId: PROJECT,
      commandId: req.commandId,
    });
    assert.equal(saved.admissionState, undefined);
    assert.equal(saved.params.requestId, value.operationId);
  });
  await check(
    "outcome-persistence-failure-remains-unknown-even-with-answered-status",
    async (f) => {
      f.failJournal("outcome");
      const req = f.request();
      assert.equal((await f.run(req)).admissionState, "unknown");
      assert.equal(f.item.status, "answered");
      assert.equal(f.project.pending.length, 1);
      assert.equal((await f.commandRead(req.commandId)).admissionState, "unknown");
      assert.equal(f.calls.length, 1);
    },
  );
  await check("invalid-native-task-receipt-cannot-become-known", async (f) => {
    f.response = {
      accepted: true,
      messageId: "m",
      taskId: "foreign",
      runId: "run",
      channelSequence: 3,
    };
    assert.equal((await f.run(f.request())).admissionState, "unknown");
    assert.equal(f.project.pending.length, 1);
  });
  await check("pending-persistence-failure-dispatches-nothing", async (f) => {
    f.failJournal("pending");
    await assert.rejects(f.run(f.request()), /disk full/);
    assert.equal(f.calls.length, 0);
  });
  await check(
    "paused-reply-has-no-resume-command-and-terminal-expired-answered-conflict",
    async (f) => {
      for (const state of ["answered", "expired", "cancelled"]) {
        f.item.status = state;
        await assert.rejects(f.run(f.request()), { code: "TARGET_CHANGED" });
      }
      f.item.status = "pending";
      f.item.expiresAt = 1;
      await assert.rejects(f.run(f.request()), { code: "TARGET_CHANGED" });
      f.item.expiresAt = Math.floor(Date.now() / 1000) + 600;
      for (const state of ["completed", "failed", "cancelled"]) {
        f.task.runs[0].status = state;
        await assert.rejects(f.run(f.request()), { code: "TARGET_CHANGED" });
      }
      f.task.runs[0].status = "paused";
      f.task.paused = true;
      assert.equal((await f.run(f.request())).admissionState, "accepted");
      assert.equal(f.task.paused, true);
      assert.deepEqual(
        f.calls.map((v) => v.method),
        ["areal/channel/reply"],
      );
    },
  );
  await check(
    "two-device-native-conflict-keeps-distinct-original-command-associations",
    async (f) => {
      const a = f.request(),
        b = f.request({ ...f.target(), answers: { choice: "B", free: "other" } }),
        other = { ...f.connection, peer: "b", connectionId: "b" };
      const results = await Promise.all([f.run(a), f.run(b, other)]);
      assert.equal(results.filter((v) => v.admissionState === "accepted").length, 1);
      assert.equal(results.filter((v) => v.admissionState === "rejected").length, 1);
      assert.equal(new Set(f.calls.map((v) => v.params.requestId)).size, 2);
    },
  );
  await check("detail-publication-rechecks-project-service-and-grant", async (f) => {
    f.afterRead = () => {
      f.remote.config.deviceGrants[0].revision = 2;
    };
    await assert.rejects(f.read(), { code: "GRANT_CHANGED" });
    f.remote.config.deviceGrants[0].revision = 1;
    f.afterRead = () => {
      f.project.service.generation = "changed";
    };
    await assert.rejects(f.read(), { code: "RESYNC_REQUIRED" });
    assert.equal(f.calls.length, 0);
  });
  await check(
    "answer-authority-required-for-dispatch-and-receipt-observation-publication",
    async (f) => {
      f.remote.config.deviceGrants[0].capabilities = ["observe"];
      assert.equal((await f.read()).complete, true);
      const req = f.request();
      await assert.rejects(f.run(req), { code: "FORBIDDEN" });
      assert.equal(f.calls.length, 0);
      f.remote.config.deviceGrants[0].capabilities = ["observe", "answer"];
      f.beforeReply = () => {
        f.remote.config.deviceGrants[0].capabilities = ["observe"];
      };
      await assert.rejects(f.run(req), { code: "FORBIDDEN" });
      assert.equal(Object.values(f.project.outcomes)[0].admissionState, "accepted");
      await assert.rejects(f.commandRead(req.commandId), { code: "FORBIDDEN" });
      assert.equal(f.calls.length, 1);
    },
  );
  await check("same-command-recovery-wins-delayed-new-preflight-conflict", async (f) => {
    const held = defer(),
      entered = defer();
    let first = true;
    f.afterRead = async (method) => {
      if (method === "areal/task/read" && first) {
        first = false;
        entered.resolve();
        await held.promise;
        throw Object.assign(new Error("stale task"), { code: "TARGET_CHANGED" });
      }
    };
    const req = f.request(),
      delayed = f.run(req);
    await entered.promise;
    // 另一连接共享提交账本，但使用自己的只读连接，避免同一观察队列自锁。
    const otherObservers = new SessionObservers(f.remote);
    otherObservers.connect = f.observers.connect;
    const otherQuestions = new TaskQuestions(otherObservers);
    f.afterRead = undefined;
    try {
      const accepted = await sessionCommand(
        f.remote,
        f.connection,
        req,
        (x) => x,
        undefined,
        undefined,
        otherQuestions,
      );
      assert.equal(accepted.admissionState, "accepted");
      held.resolve();
      assert.equal((await delayed).operationId, accepted.operationId);
      assert.equal(f.calls.length, 1);
    } finally {
      held.resolve();
      otherObservers.close();
    }
  });

  await check("actual-noise-direct-task-route-and-schema", async (f) => {
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
        clientVersion: "rc08-fixture",
        displayName: "fixture",
      });
      const ready = (await messages.next()).value;
      assert.ok(ready.methods.includes("task.question.read"));
      assert.ok(ready.methods.includes("task.question.reply"));
      assert.ok(!ready.methods.includes("task.reply"));
      secure.send({
        id: "detail",
        method: "task.question.read",
        context: { projectId: PROJECT },
        params: f.target(),
      });
      const detail = (await messages.next()).value.result;
      assert.equal(detail.complete, true);
      assert.deepEqual(detail.questions, f.item.questions);
      assert.equal(detail.reviewToken, undefined);
      const req = f.request();
      secure.send(req);
      const value = (await messages.next()).value.result;
      assert.equal(value.admissionState, "accepted");
      assert.equal(value.receipt.taskId, "task");
      assert.equal(value.observedState.status, "answered");
      assert.equal(value.nativeRequestId, f.calls[0].params.requestId);
      secure.send({ ...req, id: "duplicate" });
      assert.equal((await messages.next()).value.result.operationId, value.operationId);
      secure.send({ ...req, id: "alias", method: "task.reply" });
      assert.equal((await messages.next()).value.error.code, "INVALID_PARAMS");
      secure.send({
        id: "injected",
        method: "task.question.read",
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

  await check(
    "unknown-task-reply-keeps-journal-without-blocking-explicit-desktop-task-control",
    async (f) => {
      f.outcomeLoss = true;
      const req = f.request();
      assert.equal((await f.run(req)).admissionState, "unknown");
      const original = f.project.pending[0];
      let localCalls = 0;
      f.project.client.request = async (method, params) => {
        assert.equal(method, "areal/task/pause");
        assert.equal(params.taskId, "task");
        localCalls++;
        return { accepted: true, taskId: "task" };
      };
      await f.backend.submit(f.project, "areal/task/pause", {
        taskId: "task",
        expectedRevision: 1,
      });
      assert.equal(localCalls, 1);
      assert.equal(f.project.pending.length, 1);
      assert.deepEqual(f.project.pending[0], original);
      assert.equal((await f.commandRead(req.commandId)).admissionState, "unknown");
    },
  );
} finally {
  await owner.close();
}

console.log(
  JSON.stringify({ kind: "fixture-contract", checks, passed: checks.length, home }, null, 2),
);
