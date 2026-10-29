const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const { randomUUID } = require("node:crypto");
const appRequire = createRequire(resolve(__dirname, "../app/package.json"));
const { WebSocketServer } = appRequire("ws");
const { CloudClient } = require("../app/src/core/cloud-client.cjs");
const { CloudConversations } = require("../app/src/core/cloud-conversations.cjs");

test("原生 WS 协议夹具：并发创建去重、流式投影、重启复用绑定且不重发 query", async (t) => {
  let allocations = 0,
    queries = 0,
    persisted = [];
  const thread = { id: "thread-one", turns: [], status: { type: "idle" } };
  const http = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const ws = new WebSocketServer({ server: http });
  ws.on("connection", (socket, req) => {
    assert.equal(req.headers.authorization, "Bearer token");
    assert.equal(req.url, `/api/${request.requestId}/`);
    socket.on("message", (raw) => {
      const { id, method, params } = JSON.parse(raw);
      if (!id) return;
      const reply = (result) => socket.send(JSON.stringify({ id, result }));
      if (method === "initialize") return reply({});
      if (method === "areal/capabilities")
        return reply({
          apiVersion: "areal.core.v1",
          methods: ["areal/thread/observe", "areal/thread/start"],
        });
      if (method === "areal/profile/list") return reply({ data: [] });
      if (method === "areal/thread/start") allocations++;
      if (method === "areal/thread/start" || method === "areal/thread/observe")
        return reply({ thread });
      assert.equal(method, "turn/start");
      assert.deepEqual(Object.keys(params).sort(), ["input", "threadId"]);
      queries++;
      const turn = { id: `turn-${queries}`, status: "inProgress", items: [] };
      reply({ turn });
      const event = (method, params) => socket.send(JSON.stringify({ method, params }));
      event("turn/started", { threadId: thread.id, turn });
      event("item/started", {
        threadId: thread.id,
        turnId: turn.id,
        item: { id: "answer", type: "agentMessage", text: "" },
      });
      event("item/agentMessage/delta", {
        threadId: thread.id,
        turnId: turn.id,
        itemId: "answer",
        delta: "streamed answer",
      });
      turn.status = "completed";
      turn.items = [{ id: "answer", type: "agentMessage", text: "streamed answer" }];
      thread.turns.push(turn);
      event("turn/completed", { threadId: thread.id, turn });
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(() => {
    for (const socket of ws.clients) socket.terminate();
    ws.close();
    http.closeAllConnections();
    http.close();
  });
  let platform = new CloudClient({
    baseURL: `http://127.0.0.1:${http.address().port}/api`,
    token: "token",
  });
  const backend = {
    textInput: (text) => [{ type: "text", text }],
    saved: [{ id: "project" }],
    cloud: { client: async () => platform },
    save: async (_name, value) => {
      persisted = structuredClone(value);
    },
    onChange() {},
    snapshot() {
      return {};
    },
  };
  const manager = new CloudConversations(backend);
  t.after(() => manager.close());
  const request = { projectId: "project", operation: "create", requestId: randomUUID() };
  const [first, second] = await Promise.all([manager.command(request), manager.command(request)]);
  assert.deepEqual(first, second);
  assert.equal(first.sessionId, request.requestId);
  assert.equal(allocations, 1);
  assert.equal(persisted[0].binding.sessionId, undefined);
  await manager.command({
    projectId: "project",
    threadId: first.threadId,
    operation: "send",
    text: "hello",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    manager.projection("project").threads[first.threadId].turns[0].items[0].text,
    "streamed answer",
  );
  assert.equal(manager.owns("other-project", first.threadId), false);
  manager.close();
  const restored = new CloudConversations(backend);
  restored.records = persisted;
  t.after(() => restored.close());
  await restored.command({ projectId: "project", threadId: first.threadId, operation: "open" });
  assert.equal(restored.projection("project").threads[first.threadId].cloud.connected, false);
  await restored.open(persisted[0], true);
  assert.equal(allocations, 1);
  assert.equal(queries, 1);
  assert.equal(restored.projection("project").threads[first.threadId].turns.length, 1);
  platform = new CloudClient({
    baseURL: "https://another.example/api",
    token: "different-token",
  });
  await assert.rejects(
    restored.command({
      projectId: "project",
      threadId: first.threadId,
      operation: "send",
      text: "hello",
    }),
    /另一个 Cloud/,
  );
  assert.equal(queries, 1);
});

async function recoveryFixture(t, onObserve = (_socket, reply, thread) => reply({ thread })) {
  const thread = { id: "recovery-thread", turns: [], status: { type: "idle" } };
  const state = {
    thread,
    connections: 0,
    queries: 0,
    observe: onObserve,
    methods: ["areal/thread/start", "areal/thread/observe"],
    requests: [],
  };
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  ws.on("connection", (socket) => {
    state.connections++;
    socket.on("message", (raw) => {
      const { id, method, params } = JSON.parse(raw);
      if (!id) return;
      state.requests.push({ id, method, params });
      const reply = (result) => socket.send(JSON.stringify({ id, result }));
      if (method === "initialize") return reply({});
      if (method === "areal/capabilities")
        return reply({
          apiVersion: "areal.core.v1",
          methods: state.methods,
        });
      if (method === "areal/profile/list") return reply({ data: [] });
      if (method === "areal/thread/start") return reply({ thread });
      if (method === "areal/thread/observe") return state.observe(socket, reply, thread);
      if (method === "thread/read") {
        assert.equal(params.includeTurns, true);
        return state.observe(socket, reply, thread);
      }
      assert.equal(method, "turn/start");
      state.queries++;
      const turn = { id: `new-${state.queries}`, status: "completed", items: [] };
      thread.turns.push(turn);
      reply(state.malformedReceipt ? {} : { turn });
      socket.send(
        JSON.stringify({ method: "turn/completed", params: { threadId: thread.id, turn } }),
      );
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const platform = new CloudClient({
    baseURL: `http://127.0.0.1:${http.address().port}/api`,
    token: "token",
  });
  const backend = {
    home: "/unused",
    saved: [{ id: "project" }],
    textInput: (text) => [{ type: "text", text }],
    cloud: { client: async () => platform },
    save: async () => {},
    onChange() {},
    snapshot: () => ({}),
  };
  const manager = new CloudConversations(backend);
  t.after(() => {
    manager.close();
    for (const socket of ws.clients) socket.terminate();
    ws.close();
    http.closeAllConnections();
    http.close();
  });
  await manager.create({ projectId: "project", requestId: randomUUID() });
  return { ...state, state, manager, record: manager.records[0], ws };
}

test("旧 Core 恢复完整历史仅用 thread/read，不接管工具宿主或重发查询", async (t) => {
  const { manager, record, state } = await recoveryFixture(t);
  manager.live.get(record.id).session.client.close();
  state.methods = ["areal/thread/start", "thread/read", "thread/resume"];
  state.thread.turns = [
    {
      id: "legacy-turn",
      status: "completed",
      items: [{ id: "legacy-answer", type: "agentMessage", text: "LEGACY_HISTORY" }],
    },
  ];
  await manager.open(record, true);
  assert.equal(
    manager.projection("project").threads[state.thread.id].turns[0].items[0].text,
    "LEGACY_HISTORY",
  );
  assert.equal(state.requests.filter((r) => r.method === "thread/read").length, 1);
  assert.equal(state.requests.filter((r) => r.method === "thread/resume").length, 0);
  assert.equal(state.queries, 0);
  state.observe = (socket) =>
    socket.send(
      JSON.stringify({
        id: state.requests.at(-1).id,
        error: { code: -32003, message: "legacy read denied" },
      }),
    );
  await assert.rejects(manager.open(record, true), /legacy read denied/);
  assert.equal(state.requests.filter((r) => r.method === "thread/read").length, 2);
  assert.equal(state.requests.filter((r) => r.method === "thread/resume").length, 0);
  assert.equal(state.queries, 0);
});

test("非 UUID 创建标识在持久化或连接 workspace 前被拒绝", () => {
  const manager = new CloudConversations({ saved: [{ id: "project" }] });
  for (const requestId of [
    "-".repeat(36),
    "a".repeat(36),
    "1234567-12345-1234-1234-123456789abc",
  ]) {
    assert.throws(() => manager.create({ projectId: "project", requestId }), /标识无效/);
  }
  assert.equal(manager.records.length, 0);
  assert.equal(manager.creating.size, 0);
});

test("observe 快照与完成通知同批到达时保留最终历史", async (t) => {
  const { manager, record, state } = await recoveryFixture(t);
  state.thread.turns = [{ id: "existing-turn", status: "inProgress", items: [] }];
  state.observe = (socket, reply, thread) => {
    // 同一 TCP 批次：先发旧快照，再发随后产生的权威完成通知。
    socket._socket.cork();
    reply({ thread });
    thread.turns[0] = {
      id: "existing-turn",
      status: "completed",
      items: [{ id: "answer", type: "agentMessage", text: "finished" }],
    };
    socket.send(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: thread.id, turn: thread.turns[0] },
      }),
    );
    socket._socket.uncork();
  };
  await manager.open(record, true);
  await new Promise((resolve) => setImmediate(resolve));
  const turn = manager.projection("project").threads[state.thread.id].turns[0];
  assert.equal(turn.status, "completed");
  assert.equal(turn.items[0].text, "finished");
});

test("在途断线后显式恢复读取远端完成历史，再允许发送下一轮", async (t) => {
  const { manager, record, state, ws } = await recoveryFixture(t);
  state.thread.turns = [{ id: "offline-turn", status: "inProgress", items: [] }];
  await manager.open(record, true);
  const live = manager.live.get(record.id);
  live.session.client.close();
  for (const socket of ws.clients) socket.terminate();
  state.thread.turns[0].status = "completed";
  await manager.command({ operation: "open", projectId: "project", threadId: state.thread.id });
  assert.equal(state.connections, 1, "导航不会隐式唤醒云端运行时");
  await manager.command({
    operation: "reconnect",
    projectId: "project",
    threadId: state.thread.id,
  });
  assert.equal(manager.projection("project").threads[state.thread.id].turns[0].status, "completed");
  await manager.command({
    operation: "send",
    projectId: "project",
    threadId: state.thread.id,
    text: "next turn",
  });
  assert.equal(state.queries, 1, "恢复只读取历史，不重放上一轮查询");
  assert.equal(state.connections, 2);
});

test("Cloud 读取超过 4 MiB 的合法原生历史快照", async (t) => {
  const { manager, record, state } = await recoveryFixture(t);
  state.thread.turns = [
    {
      id: "large-turn",
      status: "completed",
      items: [
        {
          id: "large-answer",
          type: "agentMessage",
          text: "x".repeat(4 * 1024 * 1024 + 1024),
        },
      ],
    },
  ];
  await manager.open(record, true);
  assert.equal(
    manager.projection("project").threads[state.thread.id].turns[0].items[0].text.length,
    4 * 1024 * 1024 + 1024,
  );
});

test("畸形发送回执保留未知提交，恢复只读取已执行轮次而不重发", async (t) => {
  const { manager, state } = await recoveryFixture(t);
  state.malformedReceipt = true;
  await assert.rejects(
    manager.command({
      operation: "send",
      projectId: "project",
      threadId: state.thread.id,
      text: "once",
    }),
    (error) => error.submissionUnknown === true && error.outcome?.kind === "unconfirmed",
  );
  assert.equal(state.queries, 1);
  await manager.command({
    operation: "reconnect",
    projectId: "project",
    threadId: state.thread.id,
  });
  assert.equal(manager.projection("project").threads[state.thread.id].turns.length, 1);
  assert.equal(state.queries, 1);
});
