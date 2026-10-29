import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { dirname, resolve, join, extname, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

// 真实 Renderer、Cloud 适配器与远端 Core；仅桌面 preload 和项目导航用隔离测试宿主。
// 复用已有 Session，不证明空 Harness 创建或 Electron 安全存储。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");
const { CloudClient } = require("../app/src/core/cloud-client.cjs");
const { CloudConversations } = require("../app/src/core/cloud-conversations.cjs");
const config = JSON.parse(await readFile(process.env.AREAL_CLOUD_TEST_CONFIG, "utf8"));
const binding = JSON.parse(await readFile(process.env.AREAL_CLOUD_TEST_BINDING, "utf8"));
const scratch = await mkdtemp(join(tmpdir(), "areal-cloud-live-"));
const projectId = "cloud-live-project";
const platform = new CloudClient(config);
let page,
  browser,
  publishing = Promise.resolve();
const errors = [],
  events = [];
const backend = {
  home: scratch,
  saved: [{ id: projectId, root: "/cloud-live-project" }],
  cloud: { client: async () => platform },
  save: (name, value) => writeFile(join(scratch, name), JSON.stringify(value), { mode: 0o600 }),
  onChange: () => {
    if (!page || page.isClosed()) return;
    publishing = publishing
      .then(() => page.evaluate((state) => window.cloudState?.(state), backend.snapshot()))
      .catch((error) => errors.push(error.message));
  },
};
const manager = new CloudConversations(backend);
manager.records = [
  {
    id: binding.createId,
    projectId,
    title: "Cloud live acceptance",
    createdAt: Math.floor(Date.now() / 1000),
    binding,
  },
];
backend.snapshot = () => {
  const cloud = manager.projection(projectId);
  return {
    connection: { state: "ready" },
    library: { projects: {}, threads: {}, projectOrder: [], settings: {} },
    projects: [
      {
        id: projectId,
        root: "/cloud-live-project",
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
const live = await manager.open(manager.records[0], true);
live.session.client.onNotification((method, params) => events.push({ method, params }));
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
const until = async (predicate, label) => {
  const deadline = Date.now() + 120000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
try {
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("cloudSnapshot", () => backend.snapshot());
  await page.exposeFunction("cloudCommand", async (name, params) => {
    try {
      if (name === "cloudSession") return { ok: true, value: await manager.command(params) };
      if (name === "open")
        return { ok: true, value: await manager.command({ ...params, operation: "open" }) };
      return { ok: true, value: { data: [], projects: [], pendingApply: false } };
    } catch (error) {
      return {
        ok: false,
        error: { message: error.message, submissionUnknown: error.submissionUnknown === true },
      };
    }
  });
  await page.addInitScript(
    ({ projectId, threadId }) => {
      localStorage.setItem("areal-gui:project", projectId);
      localStorage.setItem(`areal-gui:thread:${projectId}`, threadId);
      window.arealDesktop = {
        snapshot: () => window.cloudSnapshot(),
        command: (name, params) => window.cloudCommand(name, params),
        onState: (listener) => {
          window.cloudState = listener;
          return () => {};
        },
        theme: async () => ({ platform: "darwin", dark: false, id: "light" }),
        onTheme: () => () => {},
        onPreviewEvent: () => () => {},
        onUpdate: () => () => {},
        onMcpAppEvent: () => () => {},
        presentReady: async () => {},
        preview: async () => ({}),
      };
    },
    { projectId, threadId: binding.threadId },
  );
  await page.goto(`http://127.0.0.1:${assets.address().port}`);
  await page.getByRole("textbox", { name: "Cloud 消息" }).waitFor();
  const prompt = "只读读取 /home/workspace/review-dev-persist.txt 并报告实际内容。不要写文件。";
  for (let round = 0; round < 2; round++) {
    const before = events.length;
    await page.getByRole("textbox", { name: "Cloud 消息" }).fill(prompt);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await until(
      () => events.slice(before).some((event) => event.method === "item/agentMessage/delta"),
      "real streaming delta",
    );
    await page.screenshot({ path: join(scratch, `stream-${round}.png`) });
    await until(
      () => events.slice(before).some((event) => event.method === "turn/completed"),
      "real completion",
    );
    await publishing;
    await page.waitForFunction(() => document.body.textContent.includes("DEV_PERSIST_793162"));
    const terminal = events.slice(before).find((event) => event.method === "turn/completed");
    assert.equal(terminal.params.turn.error, null);
    assert.ok(JSON.stringify(terminal.params.turn.items).includes("DEV_PERSIST_793162"));
    if (round === 0) {
      await page.reload();
      await page.getByRole("textbox", { name: "Cloud 消息" }).waitFor();
    }
  }
  assert.equal(manager.records[0].binding.sessionId, binding.sessionId);
  assert.equal(manager.records[0].binding.threadId, binding.threadId);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(scratch, "complete.png") });
  await writeFile(join(scratch, "events.json"), JSON.stringify(events), { mode: 0o600 });
  await writeFile(
    join(scratch, "result.json"),
    JSON.stringify({
      sessionId: binding.sessionId,
      threadId: binding.threadId,
      deltas: events.filter((event) => event.method === "item/agentMessage/delta").length,
      errors,
      scope: "real_remote_existing_session_browser_preload_test_host",
    }),
  );
  console.log(`PASS ${scratch}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(scratch, "failure.png") });
    await writeFile(
      join(scratch, "failure.txt"),
      `${error.stack}\n${await page.locator("body").innerText()}\n${JSON.stringify(errors)}`,
    );
  }
  await writeFile(join(scratch, "events.json"), JSON.stringify(events), { mode: 0o600 });
  console.error(`FAIL ${scratch}`);
  throw error;
} finally {
  manager.close();
  await browser?.close();
  assets.closeAllConnections();
  assets.close();
}
