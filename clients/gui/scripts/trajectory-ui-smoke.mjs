import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// 使用真实构建产物和隔离桌面契约 fixture，验证设置交互；不连接用户 Core。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");
const dist = join(gui, "renderer/dist");
const scratch = await mkdtemp(join(tmpdir(), "areal-trajectory-ui-"));
await readFile(join(dist, "index.html"));
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://local").pathname);
    const path = resolve(dist, pathname === "/" ? "index.html" : `.${pathname}`);
    if (!path.startsWith(dist + sep)) throw new Error("invalid asset path");
    const body = await readFile(path);
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
    response.end(body);
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser, page;
let passed = false;
const checks = [],
  errors = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.AREAL_GUI_TEST_BROWSER
      ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER }
      : { channel: "chrome" }),
  });
  page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
    serviceWorkers: "block",
  });
  // fixture 只服务本次随机 loopback 端口，意外外部资源不得连网。
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === `http://127.0.0.1:${server.address().port}`) {
      await route.continue();
      return;
    }
    errors.push("unexpected non-fixture network request");
    await route.abort();
  });
  // 浏览器继续执行真实界面与 Promise，只将轮询时钟推进交给测试控制。
  const clockStart = new Date("2026-10-12T08:00:00.000Z");
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart);
  const settled = () => page.clock.runFor(50);
  const advance = async (milliseconds) => {
    // 分段推进，让真实 Promise/模块加载完成后再安排下一轮，避免时钟越过异步结算。
    for (let remaining = milliseconds; remaining > 0; remaining -= 1000)
      await page.clock.runFor(Math.min(remaining, 1000));
    await settled();
  };
  const trajectoryCalls = () =>
    page.evaluate(() => window.calls.filter((call) => call.name === "trajectory").length);
  const click = async (name) => {
    await page.getByRole("button", { name, exact: true }).click({ force: true });
    await settled();
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.fixture = {
      enabled: true,
      config_revision: "a".repeat(64),
      state: "degraded",
      endpoint: "https://collector.example.test/ingest",
      configPath: "/isolated/config.toml",
      spool_dir: "/isolated/trajectory",
      worker_running: true,
      queue: {
        pending: 1,
        uploading: 0,
        failed: 1,
        uploaded: 3,
        evicted: 2,
        bytes: 128,
        max_bytes: 1073741824,
        dropped_memory: 1,
        dropped_oversize: 0,
      },
      last_error: "authentication_failed",
      last_success_at: 1720000120000,
      records: [
        {
          id: "batch-legacy",
          status: "failed",
          created_at: 1720000060000,
          uploaded_at: null,
          attempts: 3,
          next_attempt_at: null,
          bytes: 128,
          error: "authentication_failed",
          occurred_at: 0,
        },
        {
          id: "batch-metadata",
          status: "uploaded",
          created_at: 1720000060000,
          uploaded_at: 1720000120000,
          attempts: 1,
          next_attempt_at: null,
          bytes: 256,
          error: null,
          turn_id: "turn-fixture",
          event_name: "areal.turn.completed",
          model_name: "fixture-model",
          harness_version: "0.1.4",
          execution_duration_ms: 1200,
          occurred_at: 1720000000000,
        },
        {
          id: "batch-model-call",
          status: "uploaded",
          created_at: 1720000061000,
          uploaded_at: 1720000120100,
          attempts: 2,
          next_attempt_at: null,
          bytes: 64,
          error: null,
          event_name: "gen_ai.client.inference.operation.details",
          model_call_duration_ms: 125.5,
        },
      ],
      model_call_summary: {
        scope: "recent_records",
        record_limit: 100,
        records_considered: 3,
        model_calls: 1,
        total_duration_ms: 125.5,
        mean_duration_ms: 125.5,
        max_duration_ms: 125.5,
      },
      limits: { max_retries: 5, upload_interval_ms: 1000, max_memory_bytes: 4194304 },
    };
    window.calls = [];
    window.activeTrajectory = 0;
    window.maxActiveTrajectory = 0;
    window.toasts = [];
    document.addEventListener("areal:toast", (event) => window.toasts.push(event.detail));
    // headless 环境没有桌面最小化，显式派发浏览器可见性事件覆盖同一产品生命周期。
    window.testVisibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => window.testVisibility,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => window.testVisibility === "hidden",
    });
    window.setVisibility = (state) => {
      window.testVisibility = state;
      document.dispatchEvent(new Event("visibilitychange"));
    };
    window.readError = new URL(location.href).searchParams.has("initialError");
    window.holdNext = new URL(location.href).searchParams.has("holdStartup");
    window.delayed = [];
    let snapshot = {
      projects: [],
      connection: { state: "ready" },
      library: {
        projects: {},
        threads: {},
        projectOrder: [],
        settings: {},
        sidebarThreadOrder: [],
        sidebarRevision: 0,
        sections: [],
      },
    };
    let projectionListener,
      projectionSequence = 0;
    const emitSnapshot = (requestId) =>
      projectionListener?.({
        requestId,
        frame: {
          projection: 1,
          stream: "trajectory-fixture",
          sequence: ++projectionSequence,
          kind: "full",
          snapshot: structuredClone(snapshot),
        },
      });
    window.setTestState = (value) => {
      snapshot = value;
      emitSnapshot();
    };
    window.setConnection = (state) => window.setTestState({ ...snapshot, connection: { state } });
    window.arealDesktop = {
      onProjection: (listener) => {
        projectionListener = listener;
        return () => {
          projectionListener = undefined;
        };
      },
      requestProjection: emitSnapshot,
      theme: async () => ({ platform: "darwin", dark: false, id: "light" }),
      onTheme: (listener) => {
        window.setTestTheme = listener;
        return () => {};
      },
      setInterfaceLocale: () => {},
      onMcpAppEvent: () => () => {},
      onPreviewEvent: () => () => {},
      onUpdate: () => () => {},
      updateState: async () => ({ enabled: false, status: "idle" }),
      presentReady: async () => {},
      preview: async () => ({}),
      command: async (name, params) => {
        window.calls.push({ name, params, at: Date.now(), records: window.fixture.records.length });
        if (name === "trajectory") {
          window.activeTrajectory++;
          window.maxActiveTrajectory = Math.max(
            window.maxActiveTrajectory,
            window.activeTrajectory,
          );
          try {
            if (window.holdNext) {
              window.holdNext = false;
              return await new Promise((resolve) => window.delayed.push(resolve));
            }
            if (window.readError) return { ok: false, error: { message: "FIXTURE_READ_FAILURE" } };
            if (params.operation === "retry")
              window.fixture = {
                ...window.fixture,
                state: "ready",
                last_error: null,
                queue: { ...window.fixture.queue, failed: 0, pending: 2 },
              };
            if (params.operation === "setEnabled") {
              if (params.expectedRevision !== window.fixture.config_revision)
                return { ok: false, error: { message: "FIXTURE_REVISION_CONFLICT" } };
              window.fixture = {
                ...window.fixture,
                enabled: params.enabled,
                state: params.enabled ? "ready" : "disabled",
                config_revision: params.enabled ? "b".repeat(64) : "c".repeat(64),
              };
            }
            const value = structuredClone(window.fixture);
            if (value.model_call_summary) {
              // 新版公开契约要求汇总窗口与记录数一致；模拟接收端按当前记录生成汇总。
              const durations = value.records.flatMap((record) =>
                typeof record.model_call_duration_ms === "number"
                  ? [record.model_call_duration_ms]
                  : [],
              );
              const total = durations.reduce((sum, duration) => sum + duration, 0);
              value.model_call_summary = {
                ...value.model_call_summary,
                records_considered: value.records.length,
                model_calls: durations.length,
                total_duration_ms: durations.length ? total : null,
                mean_duration_ms: durations.length ? total / durations.length : null,
                max_duration_ms: durations.length ? Math.max(...durations) : null,
              };
            }
            return { ok: true, value };
          } finally {
            window.activeTrajectory--;
          }
        }
        if (["connect", "list", "open"].includes(name))
          return { ok: true, value: structuredClone(snapshot) };
        if (name === "projectless" && params.operation === "prepare")
          return {
            ok: true,
            value: { projectId: "fixture-projectless", cwd: "/isolated/workspace" },
          };
        if (name === "providers")
          return {
            ok: true,
            value: {
              path: "/isolated/config.toml",
              revision: "fixture",
              data: [],
              defaultModel: null,
              credentialStates: {},
              credentialSources: {},
              effective: {},
              projects: [],
              pendingApply: false,
              application: { kind: "saved", revision: "fixture" },
              definitions: [],
            },
          };
        if (name === "chatgpt")
          return {
            ok: true,
            value: {
              authenticated: false,
              state: "unauthenticated",
              email: null,
              planType: null,
              modelError: null,
              error: null,
              diagnostic: null,
              login: null,
              models: [],
              billing: "subscription",
              catalog: null,
            },
          };
        if (name === "feedback" && params.operation === "status")
          return {
            ok: true,
            value: {
              enabled: false,
              connected: false,
              opted_in: false,
              installation: null,
              account: null,
              destination: null,
            },
          };
        return { ok: true, value: { data: [], projects: [], pendingApply: false } };
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await settled();
  await page.locator('[data-testid="areal-workbench"]').waitFor();
  await page.locator('[aria-label="数据飞轮需要检查"]').waitFor();
  assert.equal(await trajectoryCalls(), 1);
  assert.equal(await page.locator(".error-banner").count(), 0);
  checks.push("initial background status warns only at settings");
  await click("设置");
  await click("数据飞轮 · 需要检查");
  await page.getByText("authentication_failed", { exact: true }).first().waitFor();
  assert.equal(
    await page.locator('.settings-navigation-item[aria-current="page"]').innerText(),
    "数据飞轮 · 需要检查",
  );
  assert.equal(
    await page.getByRole("button", { name: "模型设置", exact: true }).getAttribute("aria-pressed"),
    "false",
  );
  assert.equal(await trajectoryCalls(), 2);
  // 推进真实过渡动画后截图，避免旧导航的淡出背景造成误判。
  await page.mouse.move(800, 200);
  await advance(200);
  await page.screenshot({
    path: join(scratch, "settings.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByText("轮次 turn-fixture", { exact: true }).scrollIntoViewIfNeeded();
  await page.getByText("模型 fixture-model · Harness 0.1.4", { exact: true }).waitFor();
  await page.getByText("事件 areal.turn.completed", { exact: true }).waitFor();
  await page.getByText("Agent 执行耗时（含工具/等待）1,200毫秒", { exact: true }).waitFor();
  await page.getByText("模型调用耗时（含网络/重试）125.5毫秒", { exact: true }).waitFor();
  await page.getByText("125.5毫秒 / 125.5毫秒 / 125.5毫秒", { exact: true }).waitFor();
  await page
    .getByText("最近 3 条记录；包含请求准备、网络、排队与重试耗时。", { exact: true })
    .waitFor();
  await page
    .getByText("最近最多 100 条；重试不重复计数，缺失耗时保持未知。", { exact: true })
    .waitFor();
  assert.equal(await page.getByText(/^事件发生 /).count(), 1);
  assert.equal(await page.getByText(/^记录创建 /).count(), 3);
  assert.equal(await page.getByText(/^上传成功 /).count(), 2);
  assert.equal(await page.getByText(/undefined|Invalid Date/).count(), 0);
  await page.screenshot({
    path: join(scratch, "records.png"),
    fullPage: true,
    animations: "disabled",
  });
  checks.push(
    "navigation and metadata distinguish Agent/model durations and bounded summary from complete history",
  );

  // 通过真实翻页控件验证边界、阅读位置及轮询更新，不直接写入组件页码。
  const recordsSection = page.locator(".settings-section").filter({
    has: page.getByRole("heading", { name: "最近上传记录", exact: true }),
  });
  const pagination = recordsSection.getByRole("navigation", { name: "上传记录分页", exact: true });
  const topPagination = pagination.first();
  const recordIds = () => recordsSection.locator(".settings-field-label").allTextContents();
  const checkPage = async (current, total, first, last, count) => {
    // 时钟推进不代表 React 已提交；等待实际页码和边界记录，避免机器负载影响断言。
    await topPagination.getByText(`第 ${current} / ${total} 页`, { exact: true }).waitFor();
    for (const value of [first, last]) {
      await recordsSection
        .getByText(`batch-${String(value).padStart(3, "0")}`, { exact: true })
        .waitFor({ state: "attached" });
    }
    assert.deepEqual(
      await recordIds(),
      Array.from(
        { length: last - first + 1 },
        (_, index) => `batch-${String(first + index).padStart(3, "0")}`,
      ),
    );
    assert.equal(
      await pagination.getByText(`第 ${current} / ${total} 页`, { exact: true }).count(),
      2,
    );
    assert.equal(
      await pagination.getByText(`第 ${first}–${last} 条，共 ${count} 条`, { exact: true }).count(),
      2,
    );
    assert.equal(
      await topPagination.getByRole("button", { name: "上一页" }).isDisabled(),
      current === 1,
    );
    assert.equal(
      await topPagination.getByRole("button", { name: "下一页" }).isDisabled(),
      current === total,
    );
  };
  const turnPage = async (name, position = "top") => {
    await (position === "top" ? topPagination : pagination.last())
      .getByRole("button", { name, exact: true })
      .click({ force: true });
    await settled();
  };
  await page.evaluate(() => {
    window.originalRecords = structuredClone(window.fixture.records);
    window.fixture.records = Array.from({ length: 100 }, (_, index) => ({
      ...window.originalRecords[index % window.originalRecords.length],
      id: `batch-${String(index + 1).padStart(3, "0")}`,
    }));
    window.paginationRecords = structuredClone(window.fixture.records);
  });
  await advance(2600);
  await checkPage(1, 7, 1, 15, 100);
  await topPagination.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(scratch, "pagination-first-page.png"),
    animations: "disabled",
  });
  const beforePagination = await trajectoryCalls();
  await turnPage("下一页", "bottom");
  await checkPage(2, 7, 16, 30, 100);
  assert.equal(await topPagination.evaluate((element) => element === document.activeElement), true);
  assert.equal(
    await topPagination.evaluate((element) => element.getBoundingClientRect().top >= 0),
    true,
  );
  await turnPage("上一页");
  await checkPage(1, 7, 1, 15, 100);
  await topPagination.getByRole("button", { name: "下一页" }).focus();
  await page.keyboard.press("Enter");
  await settled();
  await checkPage(2, 7, 16, 30, 100);
  await turnPage("上一页");
  for (let current = 2; current <= 7; current++) {
    await turnPage("下一页");
    await checkPage(current, 7, (current - 1) * 15 + 1, Math.min(current * 15, 100), 100);
  }
  await checkPage(7, 7, 91, 100, 100);
  assert.equal(await trajectoryCalls(), beforePagination);
  await page.screenshot({
    path: join(scratch, "pagination-last-page.png"),
    animations: "disabled",
  });
  await advance(2600);
  await checkPage(7, 7, 91, 100, 100);
  await page.evaluate(() => {
    window.readError = true;
  });
  await advance(2600);
  await page
    .getByRole("alert")
    .getByText(/FIXTURE_READ_FAILURE/)
    .waitFor();
  await checkPage(7, 7, 91, 100, 100);
  const failedReadCalls = await trajectoryCalls();
  await turnPage("上一页");
  await checkPage(6, 7, 76, 90, 100);
  assert.equal(await trajectoryCalls(), failedReadCalls);
  await page.evaluate(() => {
    window.readError = false;
  });
  await advance(2600);
  await checkPage(6, 7, 76, 90, 100);
  assert.equal(await page.getByRole("alert").count(), 0);
  await page.evaluate(() => window.setConnection("unavailable"));
  await settled();
  const disconnectedCalls = await trajectoryCalls();
  await advance(2600);
  await checkPage(6, 7, 76, 90, 100);
  assert.equal(await trajectoryCalls(), disconnectedCalls);
  await page.evaluate(() => window.setConnection("ready"));
  await settled();
  await checkPage(6, 7, 76, 90, 100);
  await turnPage("下一页");
  checks.push(
    "keyboard pagination works; failed reads preserve and allow paging through cached records; recovery and reconnect keep the current page without extra upload requests",
  );
  await page.evaluate(() => {
    window.fixture.records = [
      { ...window.paginationRecords[0], id: "batch-new" },
      ...window.paginationRecords,
    ].slice(0, 100);
  });
  await advance(2600);
  assert.equal(await pagination.getByText("第 7 / 7 页", { exact: true }).count(), 2);
  assert.equal((await recordIds())[0], "batch-090");
  assert.equal((await recordIds()).at(-1), "batch-099");
  checks.push(
    "15 records per page; both controls navigate locally; bottom navigation returns focus and reading to the list top; polling and new records retain the current page",
  );

  await page.evaluate(() => {
    window.fixture.records = window.paginationRecords.slice(0, 16);
  });
  await advance(2600);
  await checkPage(2, 2, 16, 16, 16);
  await page.evaluate(() => {
    window.fixture.records = window.paginationRecords.slice(0, 15);
  });
  await advance(2600);
  await checkPage(1, 1, 1, 15, 15);
  await page.evaluate(() => {
    window.fixture.records = [];
  });
  await advance(2600);
  await recordsSection.getByText("暂无轨迹上传记录。", { exact: true }).waitFor();
  assert.equal(await pagination.count(), 0);
  assert.equal((await recordIds()).length, 0);
  await page.evaluate(() => {
    window.fixture.records = window.paginationRecords.slice(0, 1);
  });
  await advance(2600);
  await checkPage(1, 1, 1, 1, 1);
  await page.evaluate(() => {
    window.fixture.records = window.paginationRecords.slice(0, 16);
  });
  await advance(2600);
  await checkPage(1, 2, 1, 15, 16);
  await turnPage("下一页");
  await checkPage(2, 2, 16, 16, 16);
  checks.push(
    "empty, one-record, exact-15, 16-record, and 100-record boundaries; shrinking clamps to a valid page and growth keeps that page",
  );

  await page.setViewportSize({ width: 760, height: 900 });
  await page.evaluate(() => window.setTestTheme({ platform: "darwin", dark: true, id: "dark" }));
  await settled();
  await topPagination.scrollIntoViewIfNeeded();
  assert.equal(
    await recordsSection.evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
  );
  await page.screenshot({
    path: join(scratch, "pagination-dark-narrow.png"),
    animations: "disabled",
  });
  await turnPage("上一页");
  await checkPage(1, 2, 1, 15, 16);
  const setLocale = (locale) =>
    page.evaluate((locale) => {
      const key = "areal-gui:application-preferences";
      const newValue = JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || "{}"), locale });
      localStorage.setItem(key, newValue);
      window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
    }, locale);
  await setLocale("en");
  await settled();
  const englishPagination = page.getByRole("navigation", {
    name: "Upload records pagination",
    exact: true,
  });
  assert.equal(await englishPagination.getByText("1–15 of 16 records", { exact: true }).count(), 2);
  await englishPagination
    .first()
    .getByRole("button", { name: "Next", exact: true })
    .click({ force: true });
  await settled();
  assert.equal(await englishPagination.getByText("Page 2 / 2", { exact: true }).count(), 2);
  await page.screenshot({ path: join(scratch, "pagination-english.png"), animations: "disabled" });
  await setLocale("zh-CN");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.evaluate(() => {
    window.setTestTheme({ platform: "darwin", dark: false, id: "light" });
    window.fixture.records = window.originalRecords;
  });
  await advance(2600);
  assert.equal((await recordIds()).length, 3);
  checks.push(
    "pagination wraps within the narrow dark settings layout and supports Chinese/English labels and navigation",
  );
  // 分页场景推进了多轮时钟；重新进入可见态，让下方轮询验收从完整间隔开始。
  await page.evaluate(() => window.setVisibility("hidden"));
  await settled();
  await page.evaluate(() => window.setVisibility("visible"));
  await settled();

  // 旧 Core 缺失模型耗时字段时只显示未知，不能以零值补造统计。
  await page.evaluate(() => {
    window.durationFixture = structuredClone(window.fixture);
    delete window.fixture.model_call_summary;
    for (const record of window.fixture.records) delete record.model_call_duration_ms;
  });
  await advance(2600);
  await page.getByText("当前 Core 未提供模型调用耗时汇总，耗时未知。", { exact: true }).waitFor();
  assert.equal(await page.getByText(/^模型调用耗时（含网络\/重试）/).count(), 0);
  assert.equal(await page.getByText("0毫秒 / 0毫秒 / 0毫秒", { exact: true }).count(), 0);
  checks.push("legacy missing model durations remain unknown instead of becoming zero");

  // 修改桌面侧状态而不点击刷新，确认页内轮询实际更新队列与失败提示。
  const beforeAutomatic = await trajectoryCalls();
  await page.evaluate(() => {
    window.fixture = {
      ...window.durationFixture,
      state: "ready",
      last_error: null,
      queue: { ...window.fixture.queue, pending: 0, uploading: 0, failed: 0, uploaded: 5 },
    };
  });
  await advance(2600);
  await page.getByText("就绪", { exact: true }).waitFor();
  assert.equal(await page.locator('[aria-label="数据飞轮需要检查"]').count(), 0);
  assert.equal(await trajectoryCalls(), beforeAutomatic + 1);
  await page.getByText("0 / 0 / 0", { exact: true }).waitFor();
  checks.push("visible settings poll automatically after 2.5 seconds and recover the badge");

  const toggle = page.getByRole("switch", { name: "启用数据飞轮", exact: true });
  const switchColor = () =>
    toggle.evaluate((element) => {
      // CSS 过渡使用渲染时钟；完成过渡后检查最终颜色，避免与虚拟轮询时钟混用。
      for (const animation of element.getAnimations()) animation.finish();
      return getComputedStyle(element).backgroundColor;
    });
  assert.equal(await toggle.isChecked(), true);
  assert.equal(await switchColor(), "rgb(187, 247, 208)");
  await toggle.click();
  await settled();
  await page.getByText("未开启", { exact: true }).waitFor();
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await switchColor(), "rgb(254, 215, 170)");
  const disabledCall = await page.evaluate(() =>
    window.calls.filter((c) => c.params?.operation === "setEnabled").at(-1),
  );
  assert.deepEqual(disabledCall.params, {
    operation: "setEnabled",
    enabled: false,
    expectedRevision: "a".repeat(64),
  });
  await page.screenshot({ path: join(scratch, "switch-disabled.png"), fullPage: true });
  await toggle.click();
  await settled();
  await page.getByRole("switch", { name: "启用数据飞轮", checked: true, exact: true }).waitFor();
  assert.equal(await toggle.isChecked(), true);
  assert.equal(await switchColor(), "rgb(187, 247, 208)");
  const enabledCall = await page.evaluate(() =>
    window.calls.filter((c) => c.params?.operation === "setEnabled").at(-1),
  );
  assert.equal(enabledCall.params.expectedRevision, "c".repeat(64));
  await page.screenshot({ path: join(scratch, "switch-enabled.png"), fullPage: true });
  await page.evaluate(() => {
    window.fixture.capture_apply_pending = true;
  });
  await advance(2600);
  await page.getByText("已开启 · 待应用", { exact: true }).waitFor();
  assert.equal(await switchColor(), "rgb(254, 215, 170)");
  await page.evaluate(() => {
    delete window.fixture.capture_apply_pending;
  });
  await advance(2600);
  await page.getByText("已开启 · 待应用", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await switchColor(), "rgb(187, 247, 208)");
  checks.push(
    "real switch uses revision-fenced enable/disable IPC, pale green for ready and pale orange for off or capture pending",
  );
  await page.evaluate(() => {
    window.fixture.config_revision = "d".repeat(64);
  });
  await toggle.click();
  await settled();
  await page.getByText(/FIXTURE_REVISION_CONFLICT/).waitFor();
  assert.equal(await toggle.isChecked(), true);
  assert.equal(await toggle.isDisabled(), true);
  assert.equal(await switchColor(), "rgb(254, 215, 170)");
  await advance(2600);
  await page.getByRole("switch", { name: "启用数据飞轮", disabled: false, exact: true }).waitFor();
  assert.equal(await toggle.isChecked(), true);
  assert.equal(await toggle.isDisabled(), false);
  checks.push(
    "a stale configuration revision fails without optimistic success, disables the switch until fresh status and recovers",
  );

  // 未完成的读取跨过多个前台和后台周期时，全 GUI 仍只能有一个在途请求。
  await page.evaluate(() => {
    window.holdNext = true;
  });
  await advance(2600);
  await page.waitForFunction(() => window.delayed.length === 1);
  const heldCalls = await trajectoryCalls();
  await advance(31000);
  assert.equal(await trajectoryCalls(), heldCalls);
  assert.equal(await page.evaluate(() => window.activeTrajectory), 1);
  assert.equal(await page.evaluate(() => window.maxActiveTrajectory), 1);
  checks.push("slow requests do not overlap or queue repeated foreground/background polls");

  await page.evaluate(() => window.setVisibility("hidden"));
  await settled();
  await page.evaluate(() =>
    window.delayed.shift()({
      ok: true,
      value: { ...window.fixture, state: "degraded", last_error: "HIDDEN_STALE_RESPONSE" },
    }),
  );
  await advance(31000);
  assert.equal(await trajectoryCalls(), heldCalls);
  assert.equal(await page.getByText("HIDDEN_STALE_RESPONSE", { exact: true }).count(), 0);
  assert.equal(await page.locator('[aria-label="数据飞轮需要检查"]').count(), 0);
  await page.evaluate(() => window.setVisibility("visible"));
  await settled();
  await page.getByText("就绪", { exact: true }).waitFor();
  assert.equal(await trajectoryCalls(), heldCalls + 1);
  checks.push(
    "hidden windows stop polling and discard pending results; visibility resumes with one fresh read",
  );

  // 重试与自动读取共享在途锁；断线重连必须等待旧请求结束，再读新连接的状态。
  await page.evaluate(() => {
    window.fixture = { ...window.fixture, queue: { ...window.fixture.queue, pending: 1 } };
  });
  await advance(2600);
  await page.evaluate(() => {
    window.holdNext = true;
  });
  await click("重试上传");
  await page.waitForFunction(() => window.delayed.length === 1);
  const retryCalls = await trajectoryCalls();
  assert.equal(
    await page.getByRole("button", { name: "刷新上传状态", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "重试上传", exact: true }).isDisabled(),
    true,
  );
  await page.evaluate(() => window.setConnection("unavailable"));
  await settled();
  await page.getByText("后台未连接", { exact: true }).waitFor();
  await advance(31000);
  assert.equal(await trajectoryCalls(), retryCalls);
  await page.evaluate(() => window.setConnection("ready"));
  await settled();
  assert.equal(await trajectoryCalls(), retryCalls);
  await page.evaluate(() =>
    window.delayed.shift()({ ok: false, error: { message: "STALE_RETRY_FAILURE" } }),
  );
  await settled();
  await page.getByText("就绪", { exact: true }).waitFor();
  assert.equal(await trajectoryCalls(), retryCalls + 1);
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.equal(await page.locator('[aria-label="数据飞轮需要检查"]').count(), 0);
  assert.equal(await page.evaluate(() => window.maxActiveTrajectory), 1);
  checks.push(
    "retry and reconnect remain serial; old connection failures cannot replace fresh status",
  );

  for (const error of [
    "spool_configuration_conflict",
    "configuration_not_applied",
    "worker_not_running",
  ]) {
    await page.evaluate((error) => {
      window.fixture = { ...window.fixture, state: "degraded", last_error: error };
    }, error);
    await advance(2600);
    await page.getByText(error, { exact: true }).waitFor();
    assert.equal(await page.locator('[aria-label="数据飞轮需要检查"]').count(), 1);
  }
  checks.push("automatic reads retain safe failure categories");
  await click("重试上传");
  await page.getByText(/已请求重试/).waitFor();
  await page.getByText("就绪", { exact: true }).waitFor();
  assert.equal(await page.locator('[aria-label="数据飞轮需要检查"]').count(), 0);
  await page.evaluate(() => {
    window.readError = true;
  });
  await advance(2600);
  await page
    .getByRole("alert")
    .getByText(/FIXTURE_READ_FAILURE/)
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "重试上传", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.locator(".error-banner").count(), 0);
  await page.evaluate(() => {
    window.holdNext = true;
  });
  await advance(2600);
  await page.waitForFunction(() => window.delayed.length === 1);
  await page
    .getByRole("alert")
    .getByText(/FIXTURE_READ_FAILURE/)
    .waitFor();
  assert.equal(await page.getByText(/^记录创建 /).count(), 3);
  await page.getByText("125.5毫秒 / 125.5毫秒 / 125.5毫秒", { exact: true }).waitFor();
  await page.evaluate(() =>
    window.delayed.shift()({ ok: false, error: { message: "FIXTURE_READ_FAILURE" } }),
  );
  await settled();
  await page.evaluate(() => {
    window.readError = false;
  });
  await advance(2600);
  await page.getByText("就绪", { exact: true }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  checks.push(
    "failed polls retain records and the error during the next read, then recover without entering chat",
  );

  // 卸载专页后仅保留 App 的低频监控，不残留 2.5 秒定时器。
  // 上文主动制造过两次断线；后台监控不应新增连接提示或上报失败弹窗。
  const noticesBeforeBackground = await page.evaluate(() => window.toasts.length);
  await click("返回应用");
  const backgroundCalls = await trajectoryCalls();
  await advance(3000);
  assert.equal(await trajectoryCalls(), backgroundCalls);
  await page.evaluate(() => {
    window.readError = true;
  });
  await advance(15000);
  await page.locator('[aria-label="数据飞轮需要检查"]').waitFor();
  assert.equal(await trajectoryCalls(), backgroundCalls + 1);
  assert.equal(await page.locator(".error-banner").count(), 0);
  await page.evaluate(() => {
    window.readError = false;
  });
  await advance(15000);
  assert.equal(await page.locator('[aria-label="数据飞轮需要检查"]').count(), 0);
  assert.equal(await trajectoryCalls(), backgroundCalls + 2);
  checks.push(
    "unmounted settings leave only 15-second monitoring; later failures and recovery update the badge",
  );

  await page.evaluate(() => window.setVisibility("hidden"));
  await settled();
  const hiddenBackground = await trajectoryCalls();
  await advance(31000);
  assert.equal(await trajectoryCalls(), hiddenBackground);
  await page.evaluate(() => window.setVisibility("visible"));
  await settled();
  assert.equal(await trajectoryCalls(), hiddenBackground + 1);
  assert.equal(await page.evaluate(() => window.maxActiveTrajectory), 1);
  assert.equal(await page.locator(".error-banner").count(), 0);
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.equal(await page.evaluate(() => window.toasts.length), noticesBeforeBackground);
  checks.push(
    "background monitor pauses while hidden; repeated failures add no proactive notices or chat errors",
  );
  await page.goto(`http://127.0.0.1:${server.address().port}/?initialError=1`);
  await settled();
  await page.locator('[aria-label="数据飞轮需要检查"]').waitFor();
  assert.equal(await trajectoryCalls(), 1);
  await advance(31000);
  assert.equal(await trajectoryCalls(), 3);
  assert.equal(await page.locator(".error-banner").count(), 0);
  assert.ok(await page.evaluate(() => window.toasts.length <= 1));
  await page.evaluate(() => {
    window.readError = false;
    window.fixture = { ...window.fixture, state: "ready", last_error: null };
  });
  await advance(15000);
  assert.equal(await page.locator('[aria-label="数据飞轮需要检查"]').count(), 0);
  checks.push(
    "initial read failure remains visible without repeated proactive notices and recovers on later polls",
  );
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  if (!passed && page && !page.isClosed()) {
    await writeFile(
      join(scratch, "failure-state.json"),
      JSON.stringify(
        await page.evaluate(() => ({
          now: Date.now(),
          calls: window.calls,
          toasts: window.toasts,
          fixtureRecords: window.fixture?.records.length,
          activeTrajectory: window.activeTrajectory,
          visibility: document.visibilityState,
          text: document.body.innerText,
        })),
        null,
        2,
      ),
    );
    await page.screenshot({ path: join(scratch, "failure.png"), animations: "disabled" });
  }
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        timing: {
          clock: "Playwright controlled browser timers",
          foreground_interval_ms: 2500,
          background_interval_ms: 15000,
          pending_request_observation_ms: 31000,
          visibility: "document visibility fixture and visibilitychange; not native minimization",
        },
        scope:
          "production renderer with isolated desktop service fixture; only owned loopback network; no Electron or Core integration",
        design: {
          interaction_families: ["I-NAV", "I-READ", "I-OBSERVE"],
          rules: ["NAV-CONTEXT-01", "READ-CONTINUITY-01", "OBSERVE-TRUTH-01"],
          pattern: "P-SETTINGS",
          owner: "renderer/src/settings/TrajectorySettings.tsx",
          reused: ["SettingsSection", "SettingsGroupCard", "SettingsRow", "Button"],
          exceptions: [],
          conditions: "1280x1000 light and 760x900 dark; default font size; Chinese and English",
          video_analysis:
            "skipped: bounded change using existing settings controls; real browser interactions and screenshots cover the affected states",
        },
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, checks, errors, evidence: scratch }));
}
