import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { chromium, _electron: electron } = require("playwright-core");
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { validateCommandResponse } = require("../packages/workbench/client/desktop-contract.cjs");
const { CoreTaskModel } = await import("../packages/workbench/client/core-model.js");
const dist = process.env.AREAL_RENDERER_DIST || join(gui, "renderer/dist");
const scratch = await makeTempDir("areal-history-ui-");
const locale = process.env.AREAL_HISTORY_UI_LOCALE || "zh-CN";
const labels =
  locale === "en"
    ? {
        older: "Load older messages",
        full: "Load full content",
        loading: "Loading full content…",
        agent: "This historical content",
        user: "This message",
        tool: "This tool record",
        loadFailed: "Could not load history. Please try again.",
      }
    : {
        older: "加载更早的消息",
        full: "加载完整内容",
        loading: "正在加载完整内容…",
        agent: "这段历史内容",
        user: "这条消息",
        tool: "这条工具记录",
        loadFailed: "历史内容加载失败，请重试。",
      };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://local").pathname);
    const path = resolve(dist, pathname === "/" ? "index.html" : `.${pathname}`);
    if (!path.startsWith(dist + sep)) throw new Error("Invalid asset path");
    response.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
      }[extname(path)] || "application/octet-stream",
    );
    response.end(await readFile(path));
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser,
  desktop,
  passed = false;
const checks = [],
  errors = [],
  fixtureDiagnostics = [];
try {
  let page;
  if (process.env.AREAL_HISTORY_UI_ELECTRON === "1") {
    const entry = join(scratch, "main.cjs");
    await writeFile(
      entry,
      `const {app,BrowserWindow}=require('electron'); app.whenReady().then(()=>{const window=new BrowserWindow({width:1280,height:960,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});window.loadURL('about:blank');});`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await electron.launch({
      executablePath: require("electron"),
      args: [entry, `--user-data-dir=${join(scratch, "electron")}`],
      env,
    });
    page = await desktop.firstWindow();
  } else {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.AREAL_GUI_TEST_BROWSER
        ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER }
        : { channel: "chrome" }),
    });
    page = await browser.newPage({
      viewport: { width: 1280, height: 960 },
      serviceWorkers: "block",
    });
  }
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("validateFixtureResponse", (name, params, value) => {
    try {
      validateCommandResponse(name, params, value);
    } catch (error) {
      const message = `fixture ${name}/${params.operation ?? "default"}: ${error.message}`;
      if (name === "history") errors.push(message);
      else fixtureDiagnostics.push(message);
    }
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  await page.addInitScript(
    ({ locale }) => {
      localStorage.setItem("areal-gui:application-preferences", JSON.stringify({ locale }));
      const threadId = "history-thread";
      const thread = {
        id: threadId,
        cwd: "/isolated/workspace",
        status: "idle",
        displayHistory: { supported: true, complete: false, omitted: false },
        turns: [
          {
            id: "latest",
            status: "completed",
            items: [
              {
                id: "latest-user",
                type: "userMessage",
                content: [{ type: "text", text: "LATEST_USER_SENTINEL" }],
              },
              {
                id: "huge",
                type: "historyDeferred",
                originalType: "agentMessage",
                cursor: "private-core-cursor",
                version: "fixture-v1",
                totalBytes: 70 * 1048576,
              },
            ],
          },
        ],
      };
      const project = {
        id: "history-project",
        root: thread.cwd,
        state: { connected: true, threads: { [threadId]: thread }, queues: {}, interactions: {} },
        models: [],
        profiles: [],
        pending: [],
        outcomes: {},
        configurations: {},
        summaries: [{ id: threadId, name: "History fixture", status: "idle" }],
      };
      const snapshot = {
        revision: 1,
        desktopCapabilities: { currentCommands: true },
        projects: [project],
        connection: { state: "ready" },
        library: {
          projects: {},
          threads: {},
          settings: {},
          projectOrder: [],
          sidebarThreadOrder: [],
          sidebarRevision: 0,
          sections: [],
        },
      };
      let listener,
        projectionListener,
        sequence = 0,
        completeLoad;
      const publish = () => {
        snapshot.revision++;
        listener?.(structuredClone(snapshot));
      };
      localStorage.setItem("areal-gui:project", project.id);
      localStorage.setItem(`areal-gui:thread:${project.id}`, threadId);
      window.calls = [];
      window.installActiveHistory = (value) => {
        Object.assign(thread, value);
        publish();
      };
      window.setModelAvailability = (availability) => {
        project.configurations[threadId] = {
          model: { providerId: "areal_openai", modelId: "remembered-model" },
        };
        project.models = [
          {
            providerId: "areal_openai",
            modelId: "remembered-model",
            displayName: "Remembered model",
            available: availability === "available",
            availability,
          },
        ];
        publish();
      };
      window.activeHistory = false;
      window.setDeferredType = (type) => {
        thread.turns[0].items[1].originalType = type;
        publish();
      };
      window.completeItem = () => {
        thread.turns.at(-1).items[1] = {
          id: "huge",
          type: "agentMessage",
          phase: "final_answer",
          text: "COMPLETE_UNICODE_雪🙂_SENTINEL",
        };
        publish();
        completeLoad?.({ ok: true, value: { loaded: true, itemId: "huge" } });
      };
      window.arealDesktop = {
        snapshot: async () => structuredClone(snapshot),
        onProjection: (callback) => {
          projectionListener = callback;
          listener = (value) =>
            callback({
              frame: {
                projection: 1,
                stream: "history-fixture",
                sequence: ++sequence,
                kind: "full",
                snapshot: value,
              },
            });
          return () => {};
        },
        requestProjection: (requestId) =>
          projectionListener({
            requestId,
            frame: {
              projection: 1,
              stream: "history-fixture",
              sequence: ++sequence,
              kind: "full",
              snapshot: structuredClone(snapshot),
            },
          }),
        theme: async () => ({ platform: "darwin", dark: false, id: "light" }),
        setInterfaceLocale: async () => {},
        onQuitRequested: () => () => {},
        onQuitProgress: () => () => {},
        onPreviewEvent: () => () => {},
        onUpdate: () => () => {},
        onNotificationOpen: () => () => {},
        onMcpAppDeepLink: () => () => {},
        onTheme: () => () => {},
        onMcpAppEvent: () => () => {},
        presentReady: async () => {},
        preview: async () => ({}),
        command: async (name, params) => {
          window.calls.push({ name, params });
          if (name === "history" && window.activeHistory)
            return window.activeHistoryCommand(params);
          if (name === "history") {
            if (params.operation === "loadItem") {
              thread.displayHistory.loadingItems = { huge: { bytes: 0, totalBytes: 70 * 1048576 } };
              publish();
              return new Promise((resolve) => {
                completeLoad = resolve;
              });
            }
            if (params.operation === "loadOlder") {
              thread.turns.unshift({
                id: "old",
                status: "completed",
                items: [
                  {
                    id: "old-answer",
                    type: "agentMessage",
                    phase: "final_answer",
                    text: "OLDER_PAGE_SENTINEL",
                  },
                ],
              });
              thread.displayHistory.complete = true;
              publish();
            }
            if (params.operation === "release") return { ok: true, value: { released: true } };
            if (params.operation === "retain")
              return {
                ok: true,
                value: {
                  supported: true,
                  retained: true,
                  revision: params.revision,
                  viewGeneration: "fixture-view",
                },
              };
            if (params.operation === "ensureAnchor")
              return {
                ok: true,
                value: {
                  supported: true,
                  kind: "missing",
                  revision: params.revision,
                  viewGeneration: "fixture-view",
                },
              };
            if (params.operation === "acquire")
              return {
                ok: true,
                value: { supported: true, complete: thread.displayHistory.complete },
              };
            return { ok: true, value: { data: [], complete: true, nextCursor: null } };
          }
          if (["connect", "list", "open"].includes(name))
            return { ok: true, value: structuredClone(snapshot) };
          if (name === "workspace") return { ok: true, value: { git: true, branch: "main" } };
          if (name === "trajectory")
            return {
              ok: true,
              value: { enabled: false, state: "disabled", queue: {}, records: [] },
            };
          return { ok: true, value: { data: [] } };
        },
      };
      const command = window.arealDesktop.command;
      window.arealDesktop.command = async (name, params) => {
        const response = await command(name, params);
        if (response.ok) await window.validateFixtureResponse(name, params, response.value);
        return response;
      };
    },
    { locale },
  );
  await page.goto(origin);
  await page.getByText("LATEST_USER_SENTINEL", { exact: true }).waitFor();
  const editor = page.getByTestId("chat-input");
  await editor.fill("KEEP_DRAFT_WHILE_MODEL_CHECKING");
  await page.evaluate(() => window.setModelAvailability("checking"));
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(
    await page.locator(".composer-submit-feedback").count(),
    0,
    "checking model does not show an unavailable warning",
  );
  assert.equal(
    await page.getByTestId("chat-send-button").isEnabled(),
    true,
    "checking model does not block sending",
  );
  const beforeModelRefresh = await page.locator(".composer-dock").boundingBox();
  await page.evaluate(() => window.setModelAvailability("available"));
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(
    (await page.locator(".composer-dock").boundingBox()).y,
    beforeModelRefresh.y,
    "model refresh preserves composer position",
  );
  await editor.fill("");
  checks.push("model discovery does not block submission or move composer");
  const older = page.getByRole("button", { name: labels.older, exact: true });
  await older.waitFor({ timeout: 3000 });
  // 固定消息内容，只切换恢复/分页状态，避免把正文增长误判为控件引起的跳动。
  const historyPosition = () =>
    page.locator('[data-turn-id="latest"]').evaluate((element) => ({
      top: element.getBoundingClientRect().top,
      left: element.getBoundingClientRect().left,
      composerTop: document.querySelector(".composer-dock")?.getBoundingClientRect().top,
    }));
  const initialPosition = await historyPosition();
  const positions = [initialPosition];
  for (const displayHistory of [
    { supported: true, complete: false, latestTurnComplete: false, loadingLatest: true },
    { supported: true, complete: false, latestTurnComplete: true, loadingLatest: false },
    { supported: true, complete: false, latestTurnComplete: true, loadingOlder: true },
    { supported: true, complete: true, latestTurnComplete: true },
  ]) {
    await page.evaluate(
      (displayHistory) => window.installActiveHistory({ displayHistory }),
      displayHistory,
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    positions.push(await historyPosition());
  }
  await page.screenshot({ path: join(scratch, "00-history-controls.png"), animations: "disabled" });
  await writeFile(join(scratch, "history-positions.json"), JSON.stringify(positions, null, 2));
  for (const position of positions) {
    assert.ok(
      Math.abs(position.top - initialPosition.top) <= 1,
      "history controls do not move message content",
    );
    assert.equal(position.left, initialPosition.left, "history controls preserve column alignment");
    assert.equal(
      position.composerTop,
      initialPosition.composerTop,
      "history controls do not move composer",
    );
  }
  checks.push(
    "restoring, older-page loading and exhausted history preserve message and composer positions",
  );
  await page.evaluate(() =>
    window.installActiveHistory({
      displayHistory: { supported: true, complete: false, latestTurnComplete: true },
    }),
  );
  await older.waitFor();
  assert.equal(
    (await page.evaluate(() => window.calls)).filter(
      (call) => call.name === "history" && call.params.operation === "loadItem",
    ).length,
    0,
  );
  await page.getByText(labels.agent, { exact: false }).waitFor();
  await page.evaluate(() => window.setDeferredType("userMessage"));
  await page.getByText(labels.user, { exact: false }).waitFor();
  await page.evaluate(() => window.setDeferredType("dynamicToolCall"));
  await page.getByText(labels.tool, { exact: false }).waitFor();
  await page.evaluate(() => window.setDeferredType("agentMessage"));
  await page.getByRole("button", { name: labels.full, exact: true }).click();
  await page.getByText(labels.loading, { exact: false }).waitFor();
  assert.equal(await page.getByText("COMPLETE_UNICODE_雪🙂_SENTINEL", { exact: true }).count(), 0);
  await page.screenshot({ path: join(scratch, "01-explicit-loading.png"), animations: "disabled" });
  await page.evaluate(() => window.completeItem());
  await page.getByText("COMPLETE_UNICODE_雪🙂_SENTINEL", { exact: true }).waitFor();
  await older.click();
  await page.getByText("OLDER_PAGE_SENTINEL", { exact: true }).waitFor();
  const texts = await page.locator("[data-turn-id]").allTextContents();
  assert.ok(
    texts[0].includes("OLDER_PAGE_SENTINEL") &&
      texts.at(-1).includes("COMPLETE_UNICODE_雪🙂_SENTINEL"),
  );
  const calls = await page.evaluate(() => window.calls);
  assert.equal(
    calls.some((call) => ["send", "continue", "steer"].includes(call.name)),
    false,
  );
  assert.ok(
    calls.some(
      (call) =>
        call.name === "history" && call.params.operation === "acquire" && call.params.viewId,
    ),
  );
  await page.screenshot({ path: join(scratch, "02-loaded.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
  checks.push(
    "real deferred marker stays visible during explicit load, complete Unicode content replaces it, older messages prepend without losing latest content, no send",
  );
  const model = new CoreTaskModel();
  const activeTurn = {
    id: "active",
    status: "inProgress",
    items: [
      { id: "live-answer", type: "agentMessage", text: "ACTIVE_LIVE_SENTINEL" },
      { id: "active-tail", type: "agentMessage", text: "Active tail.\n\n".repeat(50) },
    ],
  };
  const latest = () => ({
    thread: {
      id: "history-thread",
      cwd: "/isolated/workspace",
      status: "active",
      turns: [structuredClone(activeTurn)],
    },
    history: { snapshotId: "active-snapshot", nextCursor: "active:0", complete: false },
  });
  let activePage = 0;
  const rpc = [];
  const project = { id: "history-project", model, connectionGeneration: 1 };
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
    request: async (method, params, options) => {
      rpc.push({ method, params, maxResponseBytes: options?.maxResponseBytes });
      assert.equal(method, "areal/conversation/history");
      assert.ok(params.maxBytes <= 1048576 && options.maxResponseBytes <= 1048576);
      const n = Number(params.cursor.split(":")[1]);
      activePage++;
      const first = n === 5;
      const item = first
        ? {
            id: "active-user",
            type: "userMessage",
            content: [{ type: "text", text: "ACTIVE_USER_SENTINEL" }],
          }
        : { id: `active-message-${n}`, type: "agentMessage", text: `ACTIVE_STEP_${n}_SENTINEL` };
      return {
        snapshotId: "active-snapshot",
        data: [
          {
            sourceThreadId: "history-thread",
            sourceTurnId: "active",
            sourceItemId: item.id,
            sourceTurnStatus: "inProgress",
            turn: { id: "active", status: "inProgress" },
            item,
          },
        ],
        nextCursor: first ? null : `active:${n + 1}`,
        complete: first,
      };
    },
  };
  backend.installObservation(project, latest());
  await page.exposeFunction("activeHistoryCommand", async (request) => {
    try {
      return { ok: true, value: await backend.historyCommand(project, request) };
    } catch (error) {
      return { ok: false, error: { message: error.message } };
    }
  });
  let projection = Promise.resolve();
  const publishActive = () => {
    const value = structuredClone(model.state.threads["history-thread"]);
    projection = projection.then(() =>
      page.evaluate((value) => window.installActiveHistory(value), value),
    );
  };
  model.subscribe(publishActive);
  await page.evaluate((value) => {
    window.activeHistory = true;
    window.installActiveHistory(value);
  }, model.state.threads["history-thread"]);
  await page.getByText("ACTIVE_USER_SENTINEL", { exact: true }).waitFor();
  await page.getByText("ACTIVE_LIVE_SENTINEL", { exact: true }).waitFor();
  assert.equal(
    activePage,
    6,
    "latest turn loads across more than four bounded pages without a click",
  );
  assert.equal(await older.count(), 0, "one active turn never needs a load-older button");
  assert.equal(await page.getByText("ACTIVE_STEP_0_SENTINEL", { exact: true }).count(), 1);
  model.event("item/agentMessage/delta", {
    threadId: "history-thread",
    turnId: "active",
    itemId: "live-answer",
    delta: "_CONTINUED",
  });
  await page.getByText("ACTIVE_LIVE_SENTINEL_CONTINUED", { exact: true }).waitFor();
  const followLatest = async () => {
    const bottom = page.getByRole("button", { name: "滚动到底部", exact: true });
    if (await bottom.isVisible()) await bottom.click();
    await page.waitForFunction(() =>
      JSON.parse(sessionStorage.getItem("areal-gui:reading-views:v1") || "{}").views?.some(
        (view) => view.position.kind === "latest",
      ),
    );
  };
  await followLatest();
  // 重新观察（打开会话、上下文压缩）期间，已显示的对话不随历史窗口重建而位移，
  // 渲染端只重新登记视图，不先释放再获取。
  const before = await page.evaluate(() => window.calls.length);
  await page.evaluate(() => {
    const live = () =>
      [...document.querySelectorAll(".message-column *")].find(
        (node) => node.childElementCount === 0 && node.textContent.includes("ACTIVE_LIVE_SENTINEL"),
      );
    window.liveTops = [];
    window.sampling = true;
    const sample = () => {
      const node = live();
      if (node) window.liveTops.push(Math.round(node.getBoundingClientRect().top));
      if (window.sampling) requestAnimationFrame(sample);
    };
    sample();
  });
  backend.installObservation(project, latest());
  await projection;
  await page.waitForTimeout(500);
  const liveTops = await page.evaluate(() => {
    window.sampling = false;
    return window.liveTops;
  });
  assert.ok(
    Math.max(...liveTops) - Math.min(...liveTops) <= 1,
    `re-observation moves displayed messages: ${[...new Set(liveTops)].join(",")}`,
  );
  const observationCalls = (await page.evaluate(() => window.calls))
    .slice(before)
    .filter((call) => call.name === "history")
    .map((call) => call.params.operation);
  assert.equal(observationCalls.filter((operation) => operation === "acquire").length, 1);
  assert.ok(observationCalls.every((operation) => ["acquire", "retain"].includes(operation)));
  await page.getByText("ACTIVE_USER_SENTINEL", { exact: true }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".message-column")?.textContent.includes("加载更早的消息"),
  );
  await page.screenshot({ path: join(scratch, "03-active-turn.png"), animations: "disabled" });
  assert.ok(rpc.every((call) => call.method === "areal/conversation/history"));
  checks.push(
    "real Desktop history owner automatically restores six-page active turn, retains prompt after refresh without moving displayed messages or releasing the view, and streaming continues without send or manual pagination",
  );
  await projection;
  assert.deepEqual(errors, []);
  // Real Renderer + Desktop owner: auto pagination must require fresh input,
  // preserve the visible paragraph and stop retrying after a failed read.
  let pageReads = 0;
  let failNext = false;
  let shortPages = false;
  project.client.request = async (method, params) => {
    assert.equal(method, "areal/conversation/history");
    pageReads++;
    if (failNext) {
      failNext = false;
      throw new Error("PAGING_FAILURE_SENTINEL");
    }
    const n = params.cursor === "paging:0" ? 0 : Number(params.cursor.split(":")[1]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    return {
      snapshotId: "paging-snapshot",
      data: [
        {
          sourceThreadId: "history-thread",
          sourceTurnId: `older-turn-${n}`,
          sourceItemId: `older-item-${n}`,
          sourceTurnStatus: "completed",
          turn: { id: `older-turn-${n}`, status: "completed" },
          item: {
            id: `older-item-${n}`,
            type: "agentMessage",
            phase: "final_answer",
            text: Array.from(
              { length: shortPages ? 1 : 30 },
              (_, i) => `OLDER_${n}_PARAGRAPH_${i}`,
            ).join("\n\n"),
          },
        },
      ],
      nextCursor: `paging:${n + 1}`,
      complete: false,
    };
  };
  await followLatest();
  backend.installObservation(project, {
    thread: {
      id: "history-thread",
      status: "idle",
      turns: [
        {
          id: "head",
          status: "completed",
          items: [
            {
              id: "head-item",
              type: "agentMessage",
              phase: "final_answer",
              text: "HEAD_SENTINEL\n\n" + "Reading paragraph.\n\n".repeat(40),
            },
          ],
        },
        {
          id: "tail",
          status: "completed",
          items: [
            {
              id: "tail-item",
              type: "agentMessage",
              phase: "final_answer",
              text: "TAIL_SENTINEL\n\n" + "Latest paragraph.\n\n".repeat(40),
            },
          ],
        },
      ],
    },
    history: { snapshotId: "paging-snapshot", nextCursor: "paging:0", complete: false },
  });
  await projection;
  await page.getByText("TAIL_SENTINEL", { exact: true }).waitFor();
  await page.waitForTimeout(150);
  assert.equal(pageReads, 0, "following does not fetch older pages");
  await page.locator(".messages").evaluate((element) => {
    element.scrollTop = 80;
  });
  await page.waitForTimeout(100);
  assert.equal(pageReads, 0, "layout/programmatic scroll does not authorize pagination");
  const anchorTop = () =>
    page
      .locator('[data-side-item-id="head-item"]')
      .evaluate((node) => node.getBoundingClientRect().top);
  const anchorBefore = await anchorTop();
  await page.locator(".messages").hover();
  await page.mouse.wheel(0, -1);
  await page.getByText("OLDER_0_PARAGRAPH_0", { exact: true }).waitFor();
  await page.waitForTimeout(150);
  assert.ok(
    Math.abs((await anchorTop()) - anchorBefore - 1) <= 2,
    "prepend preserves reading anchor",
  );
  assert.equal(pageReads, 1, "one gesture cannot cascade through pages");
  for (let n = 1; n < 6; n++) {
    await page.locator(".messages").evaluate((element) => {
      element.scrollTop = 40;
    });
    await page.mouse.wheel(0, -1);
    await page.getByText(`OLDER_${n}_PARAGRAPH_0`, { exact: true }).waitFor();
    await page.waitForTimeout(80);
  }
  const gap = page.locator("[data-history-page-id]").last();
  await gap.getByRole("button").click();
  await page.getByText("OLDER_1_PARAGRAPH_0", { exact: true }).waitFor();
  assert.ok(backend.historyWindow(project, "history-thread").pages.length <= 4);
  assert.equal(await page.getByText("TAIL_SENTINEL", { exact: true }).count(), 1);
  await page.screenshot({ path: join(scratch, "04-paging-gap.png"), animations: "disabled" });
  failNext = true;
  await older.click();
  await page.locator(".messages p[role=alert]").filter({ hasText: labels.loadFailed }).waitFor();
  const failedReads = pageReads;
  await page.locator(".messages").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.mouse.wheel(0, -10);
  await page.waitForTimeout(200);
  assert.equal(pageReads, failedReads, "failed automatic loads wait for an explicit retry");
  await older.click();
  await page.waitForFunction(
    (message) =>
      !document.querySelector('.messages p[role="alert"]')?.textContent.includes(message),
    labels.loadFailed,
  );
  await followLatest();
  shortPages = true;
  backend.installObservation(project, {
    thread: {
      id: "history-thread",
      status: "idle",
      turns: [
        {
          id: "short-head",
          status: "completed",
          items: [
            {
              id: "short-head-item",
              type: "agentMessage",
              phase: "final_answer",
              text: "SHORT_HEAD",
            },
          ],
        },
        {
          id: "short-tail",
          status: "completed",
          items: [
            {
              id: "short-tail-item",
              type: "agentMessage",
              phase: "final_answer",
              text: "SHORT_TAIL",
            },
          ],
        },
      ],
    },
    history: { snapshotId: "paging-snapshot", nextCursor: "paging:0", complete: false },
  });
  await projection;
  await page.getByText("SHORT_TAIL", { exact: true }).waitFor();
  const shortBefore = pageReads;
  await page.locator(".messages").hover();
  await page.mouse.wheel(0, -1);
  await page.getByText("OLDER_0_PARAGRAPH_0", { exact: true }).waitFor();
  await page.waitForTimeout(200);
  assert.equal(
    pageReads,
    shortBefore + 1,
    "underfilled viewport auto-loads at most one page per input",
  );
  for (let n = 0; n < 4; n++) {
    await page.mouse.wheel(0, -1);
    await page.waitForTimeout(100);
  }
  assert.equal(
    pageReads,
    shortBefore + 2,
    "underfilled viewport stops after two auto pages across repeated input",
  );
  await page.screenshot({ path: join(scratch, "05-short-history.png"), animations: "disabled" });
  checks.push(
    "fresh upward input auto-loads exactly one page, programmatic scrolling and follow do not fetch, prepend keeps the paragraph, evicted pages reload via gap, failure requires manual retry, underfilled viewport stops at two automatic pages even across repeated input",
  );
  await projection;
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await desktop?.close();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  const hashes = Object.fromEntries(
    await Promise.all(
      [
        "Messages.tsx",
        "ConversationHistory.tsx",
        "conversationPresentation.ts",
        "i18n/messages/common.ts",
      ].map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(join(gui, "renderer/src", file)))
          .digest("hex"),
      ]),
    ),
  );
  for (const file of [
    "app/src/core/backend.cjs",
    "app/src/core/history-observation.cjs",
    "packages/workbench/client/desktop-contract/conversation.cjs",
  ]) {
    hashes[file] = createHash("sha256")
      .update(await readFile(join(gui, file)))
      .digest("hex");
  }
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: gui,
    encoding: "utf8",
  }).trim();
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        locale,
        checks,
        errors,
        fixtureDiagnostics: [...new Set(fixtureDiagnostics)],
        hashes,
        sourceCommit,
        node: process.version,
        scope: `${desktop ? "Electron" : "Chrome"} production Renderer with actual Desktop history owner and controlled Core responses; no actual Core or packaged-app acceptance; auxiliary capability fixture diagnostics are recorded separately`,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, locale, evidence: scratch, checks, errors }));
}
