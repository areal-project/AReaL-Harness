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
let browser;
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.fixture = {
      enabled: true,
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
      ],
      limits: { max_retries: 5, upload_interval_ms: 1000, max_memory_bytes: 4194304 },
    };
    window.calls = [];
    window.readError = false;
    const snapshot = {
      projects: [],
      connection: { state: "ready" },
      library: { projects: {}, threads: {}, projectOrder: [], settings: {} },
    };
    window.arealDesktop = {
      snapshot: async () => snapshot,
      onState: (listener) => {
        window.setTestState = listener;
        return () => {};
      },
      theme: async () => ({ platform: "darwin", dark: false, id: "light" }),
      onTheme: () => () => {},
      presentReady: async () => {},
      preview: async () => ({}),
      command: async (name, params) => {
        window.calls.push({ name, params });
        if (name === "trajectory") {
          if (window.readError) return { ok: false, error: { message: "FIXTURE_READ_FAILURE" } };
          if (params.operation === "retry")
            window.fixture = {
              ...window.fixture,
              state: "ready",
              last_error: null,
              queue: { ...window.fixture.queue, failed: 0, pending: 2 },
            };
          return { ok: true, value: window.fixture };
        }
        return { ok: true, value: { data: [], projects: [], pendingApply: false } };
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('[data-testid="areal-workbench"]').waitFor();
  await page.locator('[aria-label="数据飞轮需要检查"]').waitFor();
  assert.equal(
    await page.evaluate(() => window.calls.filter((call) => call.name === "trajectory").length),
    1,
  );
  assert.equal(await page.locator(".error-banner").count(), 0);
  checks.push("initial status is read once and warns only at settings");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "数据飞轮 · 需要检查", exact: true }).click();
  await page.getByText("authentication_failed", { exact: true }).first().waitFor();
  assert.equal(
    await page.locator('.settings-navigation-item[aria-current="page"]').innerText(),
    "数据飞轮 · 需要检查",
  );
  assert.equal(
    await page.getByRole("button", { name: "模型设置", exact: true }).getAttribute("aria-pressed"),
    "false",
  );
  assert.equal(
    await page.evaluate(() => window.calls.filter((call) => call.name === "trajectory").length),
    2,
  );
  // 等导航背景过渡结束再截图，避免把旧项淡出的瞬间误认为选中状态。
  await page.mouse.move(800, 200);
  await page.locator(".settings-category-navigation").evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.screenshot({ path: join(scratch, "settings.png"), fullPage: true });
  await page.getByText("Turn turn-fixture", { exact: true }).scrollIntoViewIfNeeded();
  await page.getByText("模型 fixture-model · Harness 0.1.4", { exact: true }).waitFor();
  await page.getByText("事件 areal.turn.completed", { exact: true }).waitFor();
  await page.getByText("执行耗时 1200 ms", { exact: true }).waitFor();
  assert.equal(await page.getByText(/^事件发生 /).count(), 1);
  assert.equal(await page.getByText(/^记录创建 /).count(), 2);
  assert.equal(await page.getByText(/^上传成功 /).count(), 1);
  assert.equal(await page.getByText(/undefined|Invalid Date/).count(), 0);
  await page.screenshot({ path: join(scratch, "records.png"), fullPage: true });
  checks.push(
    "navigation selection matches the page; optional metadata and legacy records show distinct times",
  );
  await page.getByRole("button", { name: "重试上传", exact: true }).click();
  await page.getByText("已请求重试，请刷新查看上传进度。", { exact: true }).waitFor();
  assert.equal(await page.locator('[aria-label="数据飞轮需要检查"]').count(), 0);
  await page.evaluate(() => {
    window.readError = true;
  });
  await page.getByRole("button", { name: "刷新上传状态", exact: true }).click();
  await page
    .getByRole("alert")
    .getByText(/FIXTURE_READ_FAILURE/)
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "重试上传", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.locator(".error-banner").count(), 0);
  await page.getByRole("button", { name: "返回应用", exact: true }).click();
  assert.equal(await page.getByText("authentication_failed", { exact: true }).count(), 0);
  checks.push("retry updates the settings badge; read failures and metadata never enter chat");
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        scope:
          "production renderer with isolated desktop service fixture; no Electron or Core integration",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, checks, errors, evidence: scratch }));
}
