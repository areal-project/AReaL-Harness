import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { CoreTaskModel } from "../packages/workbench/client/core-model.js";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { CoreLibrary } = require("../app/src/core/library.cjs");

// 最新一轮超过一页：补全时最后一页带上一轮的尾部条目，与真实 Core 的分页边界一致。
const latest = () => ({
  thread: {
    id: "thread",
    status: "active",
    turns: [
      {
        id: "active",
        status: "inProgress",
        items: [{ id: "live", type: "agentMessage", text: "LIVE" }],
      },
    ],
  },
  history: { snapshotId: "snapshot", nextCursor: "active:0", complete: false },
});
const entry = (turnId, status, item) => ({
  sourceThreadId: "thread",
  sourceTurnId: turnId,
  sourceItemId: item.id,
  sourceTurnStatus: status,
  turn: { id: turnId, status },
  item,
});

function fixture() {
  const model = new CoreTaskModel();
  const project = { id: "project", model, connectionGeneration: 1 };
  const backend = Object.assign(Object.create(CoreBackend.prototype), {
    projects: new Map([[project.id, project]]),
    providers: { redact: (value) => value },
    library: { recordThreadActivity: async () => {} },
    onChange: () => {},
  });
  project.client = {
    ready: true,
    closed: false,
    capabilities: { features: { boundedObservation: true, boundedHistory: true } },
    request: async (method, params) => {
      assert.equal(method, "areal/conversation/history");
      // 页内条目按时间顺序；第一页只含本轮，第二页跨到上一轮尾部。
      if (params.cursor === "active:0")
        return {
          snapshotId: "snapshot",
          data: [entry("active", "inProgress", { id: "step", type: "agentMessage", text: "STEP" })],
          nextCursor: "active:1",
          complete: false,
        };
      if (params.cursor === "active:1")
        return {
          snapshotId: "snapshot",
          data: [
            entry("previous", "completed", {
              id: "previous-answer",
              type: "agentMessage",
              text: "PREVIOUS",
            }),
            entry("active", "inProgress", {
              id: "user",
              type: "userMessage",
              content: [{ type: "text", text: "USER" }],
            }),
          ],
          nextCursor: "previous:1",
          complete: false,
        };
      throw new Error(`unexpected cursor ${params.cursor}`);
    },
  };
  return { backend, project, model };
}

const shape = (thread) =>
  (thread?.turns ?? []).map((turn) => `${turn.id}:${turn.items.map((item) => item.id).join("+")}`);

test("re-observing a mounted view keeps the displayed boundary turn and its order", async () => {
  const { backend, project, model } = fixture();
  backend.installObservation(project, latest());
  await backend.historyCommand(project, {
    threadId: "thread",
    viewId: "view",
    operation: "acquire",
  });
  const settled = shape(model.state.threads.thread);
  assert.deepEqual(settled, ["previous:previous-answer", "active:user+step+live"]);
  assert.equal(model.state.threads.thread.displayHistory.latestTurnComplete, true);

  const published = [];
  const unsubscribe = model.subscribe(() => published.push(shape(model.state.threads.thread)));
  // 打开会话、上下文压缩等路径会重新观察；同一连接、未失效的窗口不应先清掉已显示内容再补回。
  backend.installObservation(project, latest());
  await backend.historyCommand(project, {
    threadId: "thread",
    viewId: "view",
    operation: "acquire",
  });
  unsubscribe();
  assert.ok(published.length > 0);
  for (const turns of published) assert.deepEqual(turns, settled);
});

test("re-observation inserts new same-turn history after its shared prefix and preserves live updates", async () => {
  const { backend, project, model } = fixture();
  const message = (id) => ({ id, type: "agentMessage", text: id });
  const items = [
    { id: "user", type: "userMessage", content: [{ type: "inputText", text: "question" }] },
    message("old-step"),
    message("old-tail"),
    message("new-step"),
    message("new-tail"),
  ];
  const observe = (item) => ({
    ...latest(),
    thread: { ...latest().thread, turns: [{ id: "active", status: "inProgress", items: [item] }] },
  });
  const page = (items) => ({
    snapshotId: "snapshot",
    data: items.map((item) => entry("active", "inProgress", item)),
    nextCursor: null,
    complete: true,
  });
  project.client.request = async () => page(items.slice(0, 2));
  const view = { threadId: "thread", viewId: "view", operation: "acquire" };
  backend.installObservation(project, observe(items[2]));
  await backend.historyCommand(project, view);
  assert.deepEqual(shape(model.state.threads.thread), ["active:user+old-step+old-tail"]);

  let finish;
  project.client.request = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  backend.installObservation(project, observe(items[4]));
  const hydration = backend.historyCommand(project, view);
  await new Promise((resolve) => setImmediate(resolve));
  model.event("item/agentMessage/delta", {
    threadId: "thread",
    turnId: "active",
    itemId: "old-step",
    delta: ":live",
  });
  model.event("item/started", {
    threadId: "thread",
    turnId: "active",
    item: message("live-suffix"),
  });
  finish(page(items.slice(0, 4)));
  await hydration;
  assert.deepEqual(shape(model.state.threads.thread), [
    "active:user+old-step+old-tail+new-step+new-tail+live-suffix",
  ]);
  assert.equal(model.state.threads.thread.turns[0].items[1].text, "old-step:live");
});

test("re-observation does not keep pages loaded through load-older", async () => {
  const { backend, project, model } = fixture();
  const request = project.client.request;
  project.client.request = async (method, params) =>
    params.cursor === "previous:1"
      ? {
          snapshotId: "snapshot",
          data: [
            entry("oldest", "completed", {
              id: "oldest-answer",
              type: "agentMessage",
              text: "OLDEST",
            }),
          ],
          nextCursor: null,
          complete: true,
        }
      : request(method, params);
  backend.installObservation(project, latest());
  const view = { threadId: "thread", viewId: "view" };
  await backend.historyCommand(project, { ...view, operation: "acquire" });
  await backend.historyCommand(project, { ...view, operation: "loadOlder" });
  assert.deepEqual(shape(model.state.threads.thread), [
    "oldest:oldest-answer",
    "previous:previous-answer",
    "active:user+step+live",
  ]);
  // 新窗口的分页游标从新快照开始；保留旧分页内容会让“加载更早”重复读到同一页。
  backend.installObservation(project, latest());
  assert.deepEqual(shape(model.state.threads.thread), [
    "previous:previous-answer",
    "active:user+step+live",
  ]);
  assert.equal(model.state.threads.thread.displayHistory.complete, false);
});

test(
  "selected conversation is visible before initialization and remains usable while navigation reads wait",
  { timeout: 5000 },
  async (t) => {
    const { once } = await import("node:events");
    const { WebSocketServer } = require("ws");
    const { ProjectConnections } = require("../app/src/core/project-connections.cjs");
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    t.after(async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    });
    const calls = [],
      held = [];
    let listRequested;
    const listing = new Promise((resolve) => {
      listRequested = resolve;
    });
    let receivedLiveDelta;
    const liveDelta = new Promise((resolve) => {
      receivedLiveDelta = resolve;
    });
    const metadata = {
      configuration: { revision: 1 },
      queue: { revision: 1, items: [] },
      interactions: [],
      interactionRevision: 1,
    };
    const capabilities = {
      methods: ["areal/thread/observe", "areal/task/host/ready", "areal/task/tools/ready"],
      features: { boundedObservation: true, boundedHistory: true },
    };
    server.on("connection", (socket) =>
      socket.on("message", (raw) => {
        const message = JSON.parse(raw);
        if (message.id === undefined) return;
        calls.push(message.method);
        let result = {};
        if (message.method === "areal/capabilities") result = capabilities;
        if (["areal/model/list", "areal/profile/list"].includes(message.method))
          result = { data: [] };
        if (message.method === "thread/list") {
          held.push(() => socket.send(JSON.stringify({ id: message.id, result: { data: [] } })));
          listRequested();
          return;
        }
        if (message.method === "areal/thread/observe")
          result = {
            thread: {
              id: message.params.threadId,
              desktop: metadata,
              turns: [
                {
                  id: "turn",
                  status: "inProgress",
                  items: [{ id: "item", type: "agentMessage", text: "base" }],
                },
              ],
            },
            history: { snapshotId: "snapshot", complete: true, nextCursor: null },
          };
        const reply = { id: message.id, result };
        socket.send(JSON.stringify(reply));
        if (message.method === "areal/thread/observe")
          socket.send(
            JSON.stringify({
              method: "item/agentMessage/delta",
              params: {
                threadId: message.params.threadId,
                turnId: "turn",
                itemId: "item",
                delta: ":live",
              },
            }),
          );
      }),
    );
    const model = new CoreTaskModel();
    const project = {
      id: "project",
      root: "/tmp",
      model,
      summaries: [],
      configurations: {},
      endpoint: `ws://127.0.0.1:${server.address().port}`,
      token: "fixture",
    };
    const snapshots = [];
    model.subscribe(() =>
      snapshots.push({ ...model.state, configuration: project.configurations.selected }),
    );
    const host = Object.assign(Object.create(CoreBackend.prototype), {
      projects: new Map([[project.id, project]]),
      starting: new Map(),
      saved: [project],
      closing: false,
      desktopToolOwner: () => host,
      desktopTools: () => [],
      worktrees: { assertAvailable() {}, async observeProject() {} },
      lifecycleOperations: {
        assertProject() {},
        schedulingSuppressed: () => false,
        blocking: () => false,
        activeTargets: new Set(),
      },
      providers: {
        manages: () => true,
        async reconcileProject() {
          // 两个 WebSocket 帧可能分属不同事件循环；等待可观察事件，不假设帧与 RPC 同步到达。
          await liveDelta;
          assert.equal(model.state.threads.selected.turns[0].items[0].text, "base:live");
          assert.deepEqual(model.state.queues.selected, metadata.queue);
          calls.push("provider");
        },
        async syncLocal() {
          calls.push("syncLocal");
        },
        async acceptModelSelection() {},
        async refreshSubscription() {},
        redact: (value) => value,
      },
      resources: {
        async syncMcp() {
          calls.push("mcp");
        },
      },
      analytics: { async syncProject() {} },
      library: { async recordThreadActivity() {}, async recordThreadSummaries() {} },
      onChange() {},
      stopReconciliation() {},
      scheduleReconciliation() {},
      async startTaskMonitor() {},
      observeNotification: (_project, _client, method, params) => {
        model.event(method, params);
        if (method === "item/agentMessage/delta") receivedLiveDelta();
      },
    });
    host._connections = new ProjectConnections(host);
    host.startProject = async () => {
      await host.connections.connect(project);
      return project;
    };
    t.after(async () => {
      host.closing = true;
      project.client?.close();
    });
    await host.start(project.id, { threadId: "selected" });
    await listing;
    assert.equal(model.state.connected, true);
    const first = snapshots.find((snapshot) => snapshot.threads.selected);
    assert.deepEqual(first.configuration, metadata.configuration);
    assert.deepEqual(first.queues.selected, metadata.queue);
    assert.deepEqual(first.interactions.selected, { revision: 1, data: [] });
    assert.equal(calls.filter((method) => method === "areal/thread/observe").length, 1);
    assert.ok(calls.indexOf("areal/thread/observe") < calls.indexOf("provider"));
    assert.ok(calls.indexOf("mcp") < calls.indexOf("areal/task/tools/ready"));
    assert.ok(calls.indexOf("areal/task/tools/ready") < calls.indexOf("thread/list"));
    assert.equal(calls.includes("areal/task/host/ready"), false);
    for (const finish of held) finish();
    await project.summaryReads;
  },
);

test(
  "live settings refresh schedule tools while ownerless and stale Main connections cannot publish",
  { timeout: 5000 },
  async (t) => {
    const { once } = await import("node:events");
    const { WebSocketServer } = require("ws");
    const { ProjectConnections } = require("../app/src/core/project-connections.cjs");
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    t.after(async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    });
    const calls = [],
      publications = [],
      responses = new Map();
    let browserAvailable = true;
    let socket,
      requestId = 0;
    server.on("connection", (connected) => {
      socket = connected;
      connected.on("message", (raw) => {
        const message = JSON.parse(raw);
        if (!message.method) {
          responses.get(message.id)?.(message);
          responses.delete(message.id);
          return;
        }
        if (message.id === undefined) return;
        calls.push(message.method);
        if (message.method === "areal/task/tools/ready") publications.push(message.params);
        const result =
          message.method === "areal/capabilities"
            ? {
                methods: [
                  "areal/thread/observe",
                  "areal/thread/tools/attach",
                  "areal/task/host/ready",
                  "areal/task/tools/ready",
                ],
                features: {
                  browserToolAttachment: browserAvailable,
                  computerToolAttachment: true,
                  computerToolPreparation: true,
                },
                browserToolBundles: [{ bundleId: "areal.browser.v1" }],
                desktopToolBundles: [{ bundleId: "areal.computer.v1" }],
              }
            : ["areal/model/list", "areal/profile/list"].includes(message.method)
              ? { data: [] }
              : {};
        connected.send(JSON.stringify({ id: message.id, result }));
      });
    });
    const call = (method, params) =>
      new Promise((resolve) => {
        const id = `server-${++requestId}`;
        responses.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    let owner = {},
      managed = true;
    const project = {
      id: "project",
      root: "/tmp",
      model: new CoreTaskModel(),
      endpoint: `ws://127.0.0.1:${server.address().port}`,
      token: "fixture",
    };
    let catalogReads = 0;
    const host = Object.assign(Object.create(CoreBackend.prototype), {
      projects: new Map([[project.id, project]]),
      starting: new Map(),
      saved: [project],
      closing: false,
      desktopToolOwner: () => owner,
      providers: {
        manages: () => managed,
        value: { defaultModel: "fixture-model" },
        async reconcileProject() {},
        async acceptModelSelection() {},
        async refreshSubscription() {},
      },
      resources: { async beforeCreate() {} },
      scheduleAdmission: { async prepare() {} },
      library: {
        value: { settings: { computerControlEnabled: true, computerControlProvider: "lcu" } },
      },
      browserRead: async () => {
        catalogReads++;
        return { success: true, contentItems: [] };
      },
      lifecycleOperations: { assertProject() {}, schedulingSuppressed: () => false },
      onChange() {},
      stopReconciliation() {},
      scheduleReconciliation() {},
      async startTaskMonitor() {},
      async listThreads() {},
      async openThread() {},
      async save() {},
    });
    const settings = host.library.value.settings;
    host.library = new CoreLibrary(host);
    Object.assign(host.library.value.settings, settings);
    host._connections = new ProjectConnections(host);
    t.after(() => {
      host.closing = true;
      project.client?.close();
    });
    await host.connections.connect(project, { observeOnly: true });
    assert.deepEqual(publications, [{ bundles: ["areal.browser.v1"] }]);
    const tool = {
      tool: "browser_v1",
      threadId: "thread",
      arguments: { operation: "describe", parameters: {} },
    };
    assert.equal((await call("item/tool/call", tool)).result.success, true);
    assert.equal(catalogReads, 1);
    const prepared = await call("areal/task/prepare", { intent: "start" });
    assert.equal(prepared.error.code, -32603);
    assert.equal(prepared.result, undefined);

    const liveClient = project.client;
    const setting = (key, value) =>
      host.executeCommand("library", { operation: "settings", key, value });
    await setting("computerControlProvider", "native");
    assert.deepEqual(publications.at(-1), {
      bundles: ["areal.browser.v1", "areal.computer.v1"],
    });
    await setting("computerControlEnabled", false);
    assert.deepEqual(publications.at(-1), { bundles: ["areal.browser.v1"] });
    await setting("computerControlEnabled", true);
    assert.deepEqual(publications.at(-1), {
      bundles: ["areal.browser.v1", "areal.computer.v1"],
    });
    await setting("computerControlProvider", "lcu");
    assert.deepEqual(publications.at(-1), { bundles: ["areal.browser.v1"] });
    await setting("computerControlProvider", "native");
    assert.deepEqual(publications.at(-1), {
      bundles: ["areal.browser.v1", "areal.computer.v1"],
    });
    await setting("computerControlEnabled", false);
    assert.deepEqual(publications.at(-1), { bundles: ["areal.browser.v1"] });
    const settingsPublications = publications.length;
    await setting("taskNotifications", false);
    assert.equal(publications.length, settingsPublications);
    managed = false;
    await setting("computerControlProvider", "lcu");
    assert.deepEqual(publications.at(-1), { bundles: [] });
    managed = true;
    await setting("computerControlProvider", "native");
    assert.deepEqual(publications.at(-1), { bundles: ["areal.browser.v1"] });
    assert.equal(project.client, liveClient);
    assert.equal(liveClient.closed, false);
    browserAvailable = false;
    await host.connections.connect(project, { observeOnly: true });
    assert.deepEqual(publications.at(-1), { bundles: [] });
    const publishedBeforeForeign = publications.length;
    managed = false;
    await host.connections.connect(project, { observeOnly: true });
    assert.equal(publications.length, publishedBeforeForeign);
    managed = true;
    browserAvailable = true;
    const firstOwner = owner,
      firstClient = project.client;

    owner = null;
    host.connections.revokeDesktopToolHost(firstOwner);
    assert.equal(firstClient.closed, true);
    await host.connections.connect(project, { observeOnly: true });
    const observer = project.client;
    const noMain = await call("areal/task/prepare", { intent: "start" });
    assert.equal(noMain.error.code, -32603);
    assert.equal(noMain.result, undefined);
    assert.equal(publications.length, publishedBeforeForeign);
    assert.deepEqual(host.desktopTools(project), []);
    assert.equal((await call("item/tool/call", tool)).result.success, false);
    assert.equal(catalogReads, 1);

    owner = {};
    host.connections.revokeDesktopToolHost(null);
    assert.equal(observer.closed, true);
    await host.connections.connect(project, { observeOnly: true });
    const successor = project.client;
    assert.deepEqual(publications.at(-1), { bundles: ["areal.browser.v1"] });
    assert.equal(publications.length, publishedBeforeForeign + 1);
    host.connections.revokeDesktopToolHost(firstOwner);
    assert.equal(successor.closed, false);
    await host.connections.publishScheduleTools(project, successor, firstOwner);
    assert.equal(publications.length, publishedBeforeForeign + 1);
    const successorOwner = owner;
    let saved, finishSave;
    const saving = new Promise((resolve) => {
      saved = resolve;
    });
    host.save = () =>
      new Promise((resolve) => {
        finishSave = resolve;
        saved();
      });
    const oldMainSettings = setting("computerControlEnabled", true);
    await saving;
    owner = {};
    finishSave();
    await oldMainSettings;
    assert.equal(publications.length, publishedBeforeForeign + 1);
    owner = successorOwner;
    assert.equal(calls.includes("areal/task/host/ready"), false);
    const late = host.connections.connect(project, { observeOnly: true });
    owner = {};
    await assert.rejects(late, /owner changed/);
    assert.equal(project.client, successor);
    assert.equal(successor.closed, false);
    assert.equal(
      calls.some((method) => method.includes("resume") || method.includes("attach")),
      false,
    );
  },
);
