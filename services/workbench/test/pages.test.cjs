"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { createPageSession, prepareInput } = require("../src/pages.cjs");
const appRequire = createRequire(join(__dirname, "../../../clients/gui/app/package.json"));
const { CoreBackend } = appRequire("@areal/workbench-service/desktop/core/backend.cjs");
const { DesktopService } = appRequire("@areal/workbench-service/desktop/core/service-protocol.cjs");

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "areal-host-pages-"));
  const backend = new CoreBackend({ home, binary: "/bin/true" });
  const thread = { id: "thread" };
  const project = { id: "project", root: home, state: { threads: { thread }, queues: {} } };
  const client = { ready: true, request: async () => ({ revoked: true }) };
  const execution = { ...project, pending: [], client, model: { state: project.state } };
  backend.projects.set(project.id, execution);
  backend.saved = [project];
  backend.snapshot = () => ({ library: { projects: {} }, projects: [project] });
  const html = "<div>Widget</div>";
  const artifact = {
    artifactId: "artifact",
    path: "/artifacts/widget.html",
    html,
    digest: createHash("sha256").update(html).digest("hex"),
  };
  const calls = [];
  let instance = 0;
  backend.command = async (_name, request, context) => {
    calls.push(request);
    if (request.operation === "genUiSource")
      return {
        text: '::visualize{path="/artifacts/widget.html" title="Widget"}',
        readOnly: false,
        artifacts: [artifact],
      };
    if (request.operation === "mcpAppOpen") {
      const result = {
        instanceId: `instance-${++instance}`,
        generation: 1,
        serverId: "server",
        resource: { html: "<h1>App</h1>", mimeType: "text/html;profile=mcp-app" },
        hostContext: {},
      };
      context.onMcpAppOpened(execution, client, request, result);
      return result;
    }
    if (request.operation === "mcpAppClose") return { closed: true };
    throw Error("Unexpected operation");
  };
  const adapter = new DesktopService(backend, "fixture");
  adapter.schedule = () => {};
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((page) => page.close()));
    adapter.close();
    backend.genUiState.dispose();
    await rm(home, { recursive: true, force: true });
  });
  const open = async () => {
    const events = [];
    const page = await createPageSession({
      appRequire,
      desktop: { backend, adapter },
      notify: (event) => events.push(event),
    });
    sessions.push(page);
    return { page, events };
  };
  return { open, backend, adapter, project, thread, calls };
}

test("后台页面会话隔离 token、关闭回执和工具租约，不占用原生外壳能力", async (t) => {
  const f = await fixture(t);
  const a = await f.open(),
    b = await f.open();
  const request = {
    operation: "open",
    projectId: "project",
    threadId: "thread",
    serverId: "server",
    expectedGeneration: 1,
    toolName: "editor",
  };
  const first = await a.page.command(request);
  const second = await b.page.command(request);
  assert.notEqual(first.token, second.token);
  assert.equal(f.adapter.computerSocket, undefined);
  assert.equal(f.adapter.mcpPageOwners.size, 2);
  assert.match(await (await a.page.resource(first.token, "/view")).text(), /<h1>App/);
  await assert.rejects(b.page.resource(first.token, "/view"), /stale/);
  await assert.rejects(b.page.command({ operation: "close", token: first.token }), /./);
  await a.page.close();
  assert.ok(
    f.calls.some(
      (call) => call.operation === "mcpAppClose" && call.instanceId === first.instanceId,
    ),
  );
  await assert.rejects(a.page.resource(first.token, "/view"), /disconnected/);
  assert.equal((await b.page.resource(second.token, "/view")).status, 200);
  f.thread.desktop = { archived: true };
  await assert.rejects(b.page.resource(second.token, "/view"), /stale/);
});

test("后台 Gen-UI 写入同一权威状态，后续模型上下文排除私有内容", async (t) => {
  const f = await fixture(t);
  const { page } = await f.open();
  const app = await page.command({
    operation: "openGenUi",
    projectId: "project",
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    referenceOffset: 0,
  });
  await page.command({ operation: "genUiVisibility", token: app.token, visible: true });
  await page.command({
    operation: "request",
    token: app.token,
    request: {
      jsonrpc: "2.0",
      id: 1,
      method: "zcode/gen-ui/state",
      params: {
        state: { modelContent: { selection: 42 }, privateContent: { note: "private-note" } },
      },
    },
  });
  const { text } = await prepareInput({
    desktop: f,
    request: { projectId: "project", threadId: "thread", text: "Continue" },
  });
  assert.match(text, /selection/);
  assert.match(text, /42/);
  assert.doesNotMatch(text, /private-note|privateContent/);
  assert.equal(await f.backend.genUiText(f.project, "other", "Continue"), "Continue");
  await page.close();
  await assert.rejects(
    page.command({ operation: "genUiVisibility", token: app.token, visible: true }),
    /disconnected/,
  );
});

test("断连发生在打开回执之前时，保留原服务连接完成实例清理，不收养迟到页面", async (t) => {
  const f = await fixture(t);
  const { page } = await f.open();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const original = f.backend.command;
  f.backend.command = async (...args) => {
    if (args[1].operation === "mcpAppOpen") {
      started.resolve();
      await release.promise;
    }
    return original(...args);
  };
  const opening = page.command({
    operation: "open",
    projectId: "project",
    threadId: "thread",
    serverId: "server",
    expectedGeneration: 1,
    toolName: "editor",
  });
  const rejected = assert.rejects(opening, /stale/);
  await started.promise;
  const closing = page.close();
  assert.equal(f.adapter.clients.size, 1);
  release.resolve();
  await rejected;
  await closing;
  assert.equal(f.adapter.clients.size, 0);
  assert.equal(f.calls.filter((call) => call.operation === "mcpAppOpen").length, 1);
  assert.equal(f.calls.filter((call) => call.operation === "mcpAppClose").length, 1);
});

test(
  "断连先取消页面在途请求，再等待服务连接清理；重复关闭共享清理回执",
  { timeout: 1000 },
  async (t) => {
    const f = await fixture(t);
    const { page } = await f.open();
    const app = await page.command({
      operation: "open",
      projectId: "project",
      threadId: "thread",
      serverId: "server",
      expectedGeneration: 1,
      toolName: "editor",
    });
    const started = Promise.withResolvers();
    const response = Promise.withResolvers();
    const original = f.backend.command;
    f.backend.command = async (...args) => {
      if (args[1].operation === "mcpAppRequest") {
        started.resolve();
        return response.promise;
      }
      return original(...args);
    };
    const request = page.command({
      operation: "request",
      token: app.token,
      request: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "editor", arguments: {} },
      },
    });
    const rejected = assert.rejects(request, /closed or stale/);
    await started.promise;
    const first = page.close();
    const second = page.close();
    try {
      await Promise.all([first, second, rejected]);
      assert.equal(f.adapter.clients.size, 0);
      assert.equal(f.calls.filter((call) => call.operation === "mcpAppClose").length, 1);
    } finally {
      response.resolve({ result: {} });
    }
  },
);

test("Host 创建和发送复用原生 owner 与原 Core 连接，句柄不能跨会话或未知重放", async (t) => {
  const f = await fixture(t);
  const project = f.backend.projects.get("project");
  project.service = { serviceId: "core", generation: "generation" };
  f.thread.status = { type: "idle" };
  f.thread.turns = [];
  project.client.capabilities = {
    methods: ["areal/thread/observe", "areal/thread/tools/attach"],
    features: { permissionPresets: true, browserToolAttachment: true },
    browserToolBundles: [{ bundleId: "areal.browser.v1" }],
  };
  f.backend.resources.beforeCreate = async () => {};
  f.backend.providers.manages = () => false;
  f.backend.readObservation = async () => ({ thread: f.thread });
  const attached = [];
  f.backend.submit = async (_project, method, params, options) => {
    assert.ok(options.preDispatch());
    attached.push({ method, params });
    return { threadId: "thread" };
  };
  f.backend.projects.delete("project");
  const native = f.adapter.connectMain(
    () => {},
    () => {},
  );
  await native.request("hello", {
    protocol: "areal.desktop-service.v1",
    identity: f.adapter.identity,
    capabilities: { computerHost: 1 },
  });
  f.backend.projects.set("project", project);
  project.client.close = () => {};
  t.after(() => native.close());
  const calls = [];
  project.client.request = async (method, params) => {
    calls.push({ method, params });
    return method === "areal/thread/start"
      ? { thread: { id: "new-thread" } }
      : { turn: { id: "accepted-turn" } };
  };
  const prepare = (method, params, connection = "first") =>
    f.adapter.prepareHostExecution(
      {
        projectId: "project",
        coreInstanceId: "core",
        coreGeneration: "generation",
        call: { method, params },
      },
      connection,
    );
  const creating = await prepare("areal/thread/start", {
    requestId: "create",
    cwd: project.root,
    options: { permissionPreset: "ask" },
  });
  assert.equal(creating.call.params.dynamicTools[0].name, "browser_v1");
  assert.equal(calls.length, 0);
  assert.equal(
    (await f.adapter.dispatchHostExecution(creating.handle, "other")).error.data.outcome.kind,
    "noMutation",
  );
  assert.equal(
    (await f.adapter.dispatchHostExecution(creating.handle, "first")).result.thread.id,
    "new-thread",
  );
  assert.deepEqual(calls[0].params, creating.call.params);
  const original = {
    requestId: "11111111-1111-4111-8111-111111111111",
    parameters: { reasoningEffort: "high", serviceTier: "fast" },
    options: { permissionPreset: "ask", readOnly: true },
    profile: { id: "profile", revision: "revision" },
    model: { providerId: "provider", modelId: "model" },
    worktree: { mode: "worktree", branch: "topic" },
    browserEnabled: true,
  };
  const commands = [];
  f.backend.command = async (name, params) => {
    commands.push({ name, params });
  };
  f.backend.worktrees.records.set(original.requestId, {
    kind: "thread",
    requestId: original.requestId,
    projectId: "project",
    parameters: Object.fromEntries(Object.entries(original).filter(([key]) => key !== "requestId")),
    state: "creating",
  });
  const rich = await prepare("workbench/thread/create", original);
  assert.equal(commands.length, 0);
  assert.deepEqual(rich.call.params, { ...original, projectId: "project" });
  assert.equal(
    (await f.adapter.dispatchHostExecution(rich.handle, "first")).result.state,
    "unknown",
  );
  assert.deepEqual(commands, [{ name: "create", params: { ...original, projectId: "project" } }]);
  const record = f.backend.worktrees.records.get(original.requestId);
  Object.assign(record, { state: "ready", threadId: "created-child", executionProjectId: "child" });
  assert.deepEqual(f.backend.worktrees.readThreadCreation("project", original), {
    state: "ready",
    requestId: original.requestId,
    threadId: "created-child",
    executionProjectId: "child",
  });
  assert.equal(
    f.backend.worktrees.readThreadCreation("project", {
      ...original,
      parameters: { reasoningEffort: "low" },
    }).state,
    "unknown",
  );
  assert.equal(commands.length, 1);
  const sending = await prepare("areal/turn/start", {
    requestId: "send",
    threadId: "thread",
    input: [{ type: "text", text: "Browse" }],
  });
  assert.equal(attached[0].params.bundleId, "areal.browser.v1");
  await f.adapter.dispatchHostExecution(sending.handle, "first");
  const entry = await f.adapter.browserEntrypoint(
    {
      projectId: "project",
      threadId: "thread",
      turnId: "accepted-turn",
      coreInstanceId: "core",
      coreGeneration: "generation",
    },
    JSON.stringify(["project", "thread"]),
  );
  assert.equal(entry.socket, f.adapter.computerSocket);
  assert.equal(entry.hostConnection, "first");
  f.adapter.disconnectHostExecution("first");
  assert.equal(f.adapter.browserEntrypoints.size, 0);
  const pending = await prepare(
    "turn/steer",
    { threadId: "thread", expectedTurnId: "accepted-turn", input: [] },
    "second",
  );
  project.client.request = async () => {
    calls.push({ unknown: true });
    throw Error("lost reply");
  };
  assert.equal(
    (await f.adapter.dispatchHostExecution(pending.handle, "second")).error.code,
    -32603,
  );
  const dispatched = calls.length;
  assert.equal(
    (await f.adapter.dispatchHostExecution(pending.handle, "second")).error.data.outcome.kind,
    "noMutation",
  );
  assert.equal(calls.length, dispatched);
});

test("元数据图片只取 Core 当前声明过的公网 https 地址", async () => {
  const { loadMetadataImage } = appRequire(
    "@areal/workbench-service/desktop/core/mcp-metadata-images.cjs",
  );
  const advertised = "https://127.0.0.1/icon.png";
  const calls = [];
  const command = async (_name, request) => {
    calls.push(request.operation);
    if (request.operation === "mcpForms")
      return { data: [{ serverId: "s", generation: 1, icons: [{ src: advertised }] }] };
    return { data: [{ serverId: "s", generation: 1, icons: [] }] };
  };
  await assert.rejects(
    loadMetadataImage(command, { source: advertised, projectId: "p" }),
    /not advertised/,
  );
  assert.deepEqual(calls, ["mcpApps"]);
  await assert.rejects(
    loadMetadataImage(command, { source: advertised, projectId: "p", threadId: "t" }),
    /Private image origin/,
  );
  assert.deepEqual(calls, ["mcpApps", "mcpApps", "mcpForms"]);
});

test("页面会话不冒充第二个 GUI，但真实第二个 GUI 仍阻止空闲停止", async (t) => {
  const f = await fixture(t);
  const { PROTOCOL } = appRequire("@areal/workbench-service/desktop/core/service-protocol.cjs");
  const main = f.adapter.connectMain(
    () => {},
    () => {},
  );
  t.after(() => main.close());
  await main.request("hello", { protocol: PROTOCOL, identity: "fixture", capabilities: {} });
  await f.open();
  assert.equal(f.adapter.packet().service.clients, 1);
  const second = f.adapter.connectMain(
    () => {},
    () => {},
  );
  t.after(() => second.close());
  await second.request("hello", { protocol: PROTOCOL, identity: "fixture", capabilities: {} });
  assert.equal(f.adapter.packet().service.clients, 2);
  second.close();
  assert.equal(f.adapter.packet().service.clients, 1);
});
