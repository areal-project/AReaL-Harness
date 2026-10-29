import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, join, extname, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// 真实 Renderer 与适配器；显式 WS 协议替身只验证资源准入，不代表 ARCA 验收。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");
const { WebSocketServer } = require("ws");
const { CloudSettings } = require("../app/src/core/cloud-settings.cjs");
const { CloudConversations } = require("../app/src/core/cloud-conversations.cjs");
const scratch = await mkdtemp(join(tmpdir(), "cloud-lifecycle-"));
const projectId = "cloud-fixture-project";
const errors = [],
  calls = [],
  workspaces = new Map();
let allocations = 0,
  queries = 0,
  deferNext = false,
  malformedNext = false,
  rejectNext = false,
  page,
  browser,
  publishing = Promise.resolve();
const native = createServer((_request, response) => {
  response.writeHead(404);
  response.end();
});
const sockets = new WebSocketServer({ server: native });
sockets.on("connection", (socket, request) => {
  assert.equal(request.headers.authorization, "Bearer fixture-token");
  const workspace = request.url.split("/").filter(Boolean).at(-1);
  if (!workspaces.has(workspace)) workspaces.set(workspace, { thread: null, alive: false });
  const state = workspaces.get(workspace);
  if (!state.alive) {
    state.alive = true;
    allocations++;
  }
  socket.on("message", (raw) => {
    const { id, method, params } = JSON.parse(raw);
    if (!id) return;
    calls.push({ workspace, method });
    const reply = (result) => socket.send(JSON.stringify({ id, result }));
    if (method === "initialize") return reply({});
    if (method === "areal/capabilities")
      return reply({
        apiVersion: "areal.core.v1",
        methods: ["areal/thread/start", "areal/thread/observe"],
      });
    if (method === "areal/profile/list") return reply({ data: [] });
    if (method === "areal/thread/start") {
      state.thread ??= { id: `thread-${workspace}`, turns: [], status: { type: "idle" } };
      return reply({ thread: state.thread });
    }
    if (method === "areal/thread/observe") return reply({ thread: state.thread });
    assert.equal(method, "turn/start");
    assert.equal(params.threadId, state.thread.id);
    if (rejectNext) {
      rejectNext = false;
      socket.send(JSON.stringify({ id, error: { code: -32000, message: "fixture rejection" } }));
      return;
    }
    queries++;
    const turn = {
      id: `turn-${queries}`,
      status: "completed",
      items: [{ id: `answer-${queries}`, type: "agentMessage", text: `QUERY_OK_${queries}` }],
      error: null,
    };
    if (deferNext) {
      deferNext = false;
      turn.status = "inProgress";
      turn.items = [];
      state.thread.turns.push(turn);
      reply({ turn });
      socket.send(
        JSON.stringify({ method: "turn/started", params: { threadId: state.thread.id, turn } }),
      );
    } else {
      state.thread.turns.push(turn);
      reply(malformedNext ? {} : { turn });
      malformedNext = false;
      socket.send(
        JSON.stringify({ method: "turn/completed", params: { threadId: state.thread.id, turn } }),
      );
    }
  });
});
native.listen(0, "127.0.0.1");
await once(native, "listening");
const backend = {
  home: scratch,
  saved: [{ id: projectId, root: "/fixture-project" }],
  textInput: (text) => [{ type: "text", text }],
  save: (name, value) => writeFile(join(scratch, name), JSON.stringify(value)),
  onChange() {
    if (page && !page.isClosed())
      publishing = publishing
        .then(() => page.evaluate((state) => window.cloudState?.(state), backend.snapshot()))
        .catch((error) => errors.push(error.message));
  },
};
backend.cloud = new CloudSettings(backend, {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
});
const manager = new CloudConversations(backend);
backend.snapshot = () => {
  const cloud = manager.projection(projectId);
  return {
    connection: { state: "ready" },
    library: { projects: {}, threads: {}, projectOrder: [], settings: {} },
    projects: [
      {
        id: projectId,
        root: "/fixture-project",
        backend: "areal",
        pending: [],
        outcomes: {},
        models: [],
        profiles: [],
        configurations: {},
        summariesLoaded: true,
        summaries: cloud.summaries,
        core: { features: {} },
        desktopCapabilities: { currentCommands: true },
        state: { connected: true, threads: cloud.threads, interactions: {}, queues: {} },
      },
    ],
  };
};
const dist = join(gui, "renderer/dist");
const assets = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://local").pathname;
    const file = resolve(
      dist,
      pathname === "/" ? "index.html" : `.${decodeURIComponent(pathname)}`,
    );
    assert.ok(file.startsWith(dist + sep));
    response.setHeader(
      "Content-Type",
      { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[extname(file)] ??
        "application/octet-stream",
    );
    response.end(await readFile(file));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
assets.listen(0, "127.0.0.1");
await once(assets, "listening");
try {
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
  });
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("cloudSnapshot", () => backend.snapshot());
  await page.exposeFunction("cloudCommand", async (name, params) => {
    try {
      let value;
      if (name === "cloud") value = await backend.cloud.command(params);
      else if (name === "cloudSession") value = await manager.command(params);
      else if (name === "open") value = await manager.command({ ...params, operation: "open" });
      else value = { data: [], projects: [], pendingApply: false };
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        error: {
          message: error.message,
          submissionUnknown: error.submissionUnknown,
          outcome: error.outcome,
          recovery: error.recovery,
        },
      };
    }
  });
  await page.addInitScript(
    ({ projectId }) => {
      localStorage.setItem("areal-gui:project", projectId);
      localStorage.setItem(`areal-draft-environment:${projectId}`, "cloud");
      let listener,
        sequence = 0;
      window.cloudState = (snapshot) =>
        listener?.({
          frame: {
            projection: 1,
            stream: "cloud-lifecycle",
            sequence: ++sequence,
            kind: "full",
            snapshot,
          },
        });
      window.arealDesktop = {
        onProjection: (callback) => {
          listener = callback;
          return () => {};
        },
        requestProjection: (requestId) =>
          window.cloudSnapshot().then((snapshot) =>
            listener?.({
              requestId,
              frame: {
                projection: 1,
                stream: "cloud-lifecycle",
                sequence: ++sequence,
                kind: "full",
                snapshot,
              },
            }),
          ),
        setInterfaceLocale: () => {},
        snapshot: () => window.cloudSnapshot(),
        command: (name, params) => window.cloudCommand(name, params),
        theme: async () => ({ platform: "darwin", dark: false, id: "light" }),
        onTheme: () => () => {},
        onPreviewEvent: () => () => {},
        onUpdate: () => () => {},
        onMcpAppEvent: () => () => {},
        presentReady: async () => {},
        preview: async () => ({}),
      };
    },
    { projectId },
  );
  await page.goto(`http://127.0.0.1:${assets.address().port}`);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "Cloud", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Cloud 后端地址" })
    .fill(`http://127.0.0.1:${native.address().port}/openapi/v1/app-server/`);
  await page.getByRole("textbox", { name: "Cloud token", exact: true }).fill("fixture-token");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "配置已保存" }).waitFor();
  assert.equal(allocations, 0);
  assert.equal(calls.length, 0);
  await page.screenshot({ path: join(scratch, "saved-without-connection.png") });
  await page.getByRole("button", { name: "返回应用", exact: true }).click();
  await page.getByTestId("cloud-chat-input").waitFor();
  await page.getByRole("status").filter({ hasText: "发送消息时恢复" }).waitFor();
  assert.equal(allocations, 0);
  assert.equal(manager.records.length, 0);
  await page.screenshot({ path: join(scratch, "draft-without-allocation.png") });
  await page.getByTestId("cloud-chat-input").fill("first query");
  await page.getByTestId("cloud-chat-send").click();
  await page.getByText("QUERY_OK_1", { exact: true }).waitFor();
  assert.equal(allocations, 1);
  const first = manager.records[0];
  assert.equal(first.binding.workspace, first.id);
  await page.screenshot({ path: join(scratch, "connected-session.png") });
  // 显式模拟回收：保留权威 thread（UPFS），关闭执行实例与连接。
  workspaces.get(first.id).alive = false;
  for (const socket of sockets.clients) socket.close();
  await page.getByRole("status").filter({ hasText: "发送消息时恢复" }).waitFor();
  await page.getByTestId("cloud-chat-input").fill("second query");
  await page.getByTestId("cloud-chat-send").click();
  await page.getByText("QUERY_OK_2", { exact: true }).waitFor();
  assert.equal(allocations, 2);
  assert.equal(queries, 2);
  assert.equal(manager.records.length, 1);
  assert.equal(calls.filter((v) => v.method === "areal/thread/start").length, 1);
  // 在途断线后服务端离线完成，显式恢复读取快照，不重放 Turn。
  deferNext = true;
  await page.getByTestId("cloud-chat-input").fill("complete while offline");
  await page.getByTestId("cloud-chat-send").click();
  await page.getByRole("button", { name: "停止", exact: true }).waitFor();
  for (const socket of sockets.clients) socket.close();
  await page.getByRole("button", { name: "恢复连接", exact: true }).waitFor();
  assert.equal(await page.getByTestId("cloud-chat-input").getAttribute("contenteditable"), "false");
  const offline = workspaces.get(first.id).thread.turns.at(-1);
  offline.status = "completed";
  offline.items = [{ id: "offline-answer", type: "agentMessage", text: "OFFLINE_COMPLETED" }];
  await page.screenshot({ path: join(scratch, "running-disconnected.png") });
  await page.getByRole("button", { name: "恢复连接", exact: true }).click();
  await page.getByText("OFFLINE_COMPLETED", { exact: true }).waitFor();
  await page.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("cloud-chat-input").getAttribute("contenteditable"), "true");
  assert.equal(queries, 3);
  assert.equal(manager.records.length, 1);
  assert.equal(calls.filter((v) => v.method === "areal/thread/start").length, 1);
  await page.screenshot({ path: join(scratch, "reconnected-completed.png") });
  // 存活的提示跟随语言切换，不将翻译结果持久化到草稿。
  await page.evaluate(() => {
    const key = "areal-gui:application-preferences";
    const newValue = JSON.stringify({
      ...JSON.parse(localStorage.getItem(key) ?? "{}"),
      locale: "en",
    });
    localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
  });
  await page.getByRole("status").filter({ hasText: "Cloud connected" }).waitFor();
  for (const socket of sockets.clients) socket.close();
  await page.getByRole("button", { name: "Reconnect", exact: true }).waitFor();
  await page.screenshot({ path: join(scratch, "reconnect-english.png") });
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Cloud connected" }).waitFor();
  assert.equal(queries, 3);
  await page.getByTestId("cloud-chat-input").fill("after reconnect");
  await page.getByTestId("cloud-chat-send").click();
  await page.getByText("QUERY_OK_4", { exact: true }).waitFor();
  await page.evaluate(() => {
    const key = "areal-gui:application-preferences";
    const newValue = JSON.stringify({
      ...JSON.parse(localStorage.getItem(key) ?? "{}"),
      locale: "zh-CN",
    });
    localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
  });
  // 成功体畸形仍按未知提交处理，文本和附件草稿不能清空或自动重发。
  malformedNext = true;
  await page.getByTestId("cloud-chat-input").fill("keep this unknown draft");
  await page.getByTestId("cloud-chat-send").click();
  await page.getByText("QUERY_OK_5", { exact: true }).waitFor();
  await page.getByRole("alert").filter({ hasText: "提交结果未知" }).waitFor();
  assert.equal(await page.getByTestId("cloud-chat-input").innerText(), "keep this unknown draft");
  assert.equal(queries, 5);
  await page.screenshot({ path: join(scratch, "unknown-receipt-draft.png") });
  await page.getByRole("button", { name: "新聊天", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "发送消息时恢复" }).waitFor();
  assert.equal(allocations, 2);
  assert.equal(manager.records.length, 1);
  await page.screenshot({ path: join(scratch, "new-chat-without-allocation.png") });
  await page.getByTestId("cloud-chat-input").fill("new workspace query");
  await page.getByTestId("cloud-chat-send").click();
  await page.getByText("QUERY_OK_6", { exact: true }).waitFor();
  await page.getByRole("status").filter({ hasText: "Cloud 已连接" }).waitFor();
  assert.equal(allocations, 3);
  assert.equal(manager.records.length, 2);
  assert.notEqual(manager.records[0].binding.workspace, manager.records[1].binding.workspace);
  assert.equal(queries, 6);
  // 首次提交被拒或结果未知后，失败草稿只属于已创建的 Thread，不污染下一次新聊天。
  for (const outcome of ["rejected", "unknown"]) {
    await page.getByRole("button", { name: "新聊天", exact: true }).click();
    const recordsBefore = manager.records.length;
    const allocationsBefore = allocations;
    await page.getByTestId("cloud-chat-input").fill(`first send ${outcome}`);
    rejectNext = outcome === "rejected";
    malformedNext = outcome === "unknown";
    await page.getByTestId("cloud-chat-send").click();
    await page
      .getByRole("alert")
      .filter({ hasText: outcome === "unknown" ? "提交结果未知" : "fixture rejection" })
      .waitFor();
    assert.equal(manager.records.length, recordsBefore + 1);
    assert.equal(allocations, allocationsBefore + 1);
    const failed = manager.records.at(-1);
    const failedQueries = workspaces.get(failed.id).thread.turns.length;
    assert.equal(await page.getByTestId("cloud-chat-input").innerText(), `first send ${outcome}`);
    await page.waitForFunction(
      (key) =>
        [key, `${key}:create`, `${key}:unknown`].every((entry) => !localStorage.getItem(entry)),
      `areal-cloud-draft:${projectId}:new`,
    );
    await page.screenshot({ path: join(scratch, `first-send-${outcome}.png`) });
    await page.getByRole("button", { name: "新聊天", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "发送消息时恢复" }).waitFor();
    assert.equal(allocations, allocationsBefore + 1);
    assert.equal(
      await page.getByTestId("cloud-chat-input").getAttribute("contenteditable"),
      "true",
    );
    assert.equal((await page.getByTestId("cloud-chat-input").innerText()).trim(), "");
    const nextQuery = queries + 1;
    await page.getByTestId("cloud-chat-input").fill(`fresh workspace after ${outcome}`);
    await page.getByTestId("cloud-chat-send").click();
    await page.getByText(`QUERY_OK_${nextQuery}`, { exact: true }).waitFor();
    await page.getByRole("status").filter({ hasText: "Cloud 已连接" }).waitFor();
    assert.equal(manager.records.length, recordsBefore + 2);
    assert.equal(allocations, allocationsBefore + 2);
    const fresh = manager.records.at(-1);
    assert.notEqual(failed.binding.workspace, fresh.binding.workspace);
    assert.equal(workspaces.get(fresh.id).thread.turns.length, 1);
    assert.equal(workspaces.get(failed.id).thread.turns.length, failedQueries);
    await page.screenshot({ path: join(scratch, `fresh-workspace-after-${outcome}.png`) });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(scratch, "evidence.json"),
    JSON.stringify(
      { fixture: true, allocations, queries, workspaces: [...workspaces.keys()], calls },
      null,
      2,
    ),
  );
  console.log(`PASS Cloud lifecycle GUI fixture: ${scratch}`);
} catch (error) {
  await page?.screenshot({ path: join(scratch, "failure.png") }).catch(() => {});
  await writeFile(
    join(scratch, "failure.json"),
    JSON.stringify(
      {
        error: error.message,
        errors,
        calls,
        body: await page
          ?.locator("body")
          .innerText()
          .catch(() => ""),
      },
      null,
      2,
    ),
  );
  console.error(`Cloud lifecycle failure evidence: ${scratch}`);
  throw error;
} finally {
  manager.close();
  await browser?.close();
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  native.closeAllConnections();
  native.close();
  assets.closeAllConnections();
  assets.close();
}
