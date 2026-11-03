import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");
const dist = join(gui, "renderer/dist");
const evidence = process.env.AREAL_BUG_REPORT_EVIDENCE_DIR || join(gui, "../../out/bug-report-ui");
await mkdir(evidence, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const path = resolve(
      dist,
      `.${new URL(req.url, "http://local").pathname === "/" ? "/index.html" : new URL(req.url, "http://local").pathname}`,
    );
    if (!path.startsWith(dist + sep)) throw new Error("invalid fixture path");
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml",
      }[extname(path)] || "application/octet-stream",
    );
    res.end(await readFile(path));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser,
  page,
  passed = false;
const errors = [],
  checks = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.AREAL_GUI_TEST_BROWSER
      ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER }
      : { channel: "chrome" }),
  });
  page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
    serviceWorkers: "block",
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  await page.addInitScript(() => {
    localStorage.setItem("areal-gui:project", "fixture");
    localStorage.setItem("areal-gui:thread:fixture", "main");
    const turns = [
      {
        id: "old",
        status: "completed",
        items: [
          { type: "userMessage", id: "q0", content: [{ type: "text", text: "先前的问题" }] },
          { type: "agentMessage", id: "a0", phase: "final_answer", text: "历史内容。".repeat(900) },
        ],
      },
      {
        id: "rated",
        status: "completed",
        items: [
          { type: "userMessage", id: "q1", content: [{ type: "text", text: "需要兼容旧接口" }] },
          {
            type: "agentMessage",
            id: "reply",
            phase: "final_answer",
            text: "已经完成新接口，等待你的反馈。",
          },
        ],
      },
    ];
    const thread = {
      id: "main",
      sessionId: "main",
      cwd: "/fixture",
      preview: "反馈功能验证",
      status: { type: "idle" },
      dynamicTools: [],
      goals: { revision: 0, eventSequence: 0 },
      turns,
    };
    const config = {
      revision: 0,
      model: { providerId: "fixture", modelId: "model" },
      options: {},
      parameters: {},
    };
    const project = {
      id: "fixture",
      root: "/fixture",
      name: "反馈验证",
      core: {
        binary: "fixture",
        apiVersion: null,
        runtimeEpoch: null,
        runtimeAvailable: true,
        instanceId: "fixture",
        connectionGeneration: 1,
        features: { sidePreview: true },
      },
      state: { connected: true, threads: { main: thread }, interactions: {}, queues: {} },
      models: [
        {
          providerId: "fixture",
          providerRevision: 1,
          modelId: "model",
          available: true,
          displayName: "Fixture",
        },
      ],
      profiles: [],
      configurations: { main: config },
      summaries: [thread],
      summariesLoaded: true,
      pending: [],
      outcomes: {},
    };
    window.fixtureSnapshot = {
      projects: [project],
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
    window.bugReports = {};
    window.failSave = true;
    let projectionListener,
      sequence = 0;
    const projection = (requestId) => ({
      ...(requestId === undefined ? {} : { requestId }),
      frame: {
        projection: 1,
        stream: "bug-report-fixture",
        sequence: ++sequence,
        kind: "full",
        snapshot: structuredClone(window.fixtureSnapshot),
      },
    });
    window.arealDesktop = {
      onProjection: (listener) => {
        projectionListener = listener;
        return () => {};
      },
      requestProjection: (requestId) => projectionListener(projection(requestId)),
      theme: async () => ({ platform: "darwin", dark: false, id: "light" }),
      onTheme: (listener) => {
        window.setFixtureTheme = listener;
        return () => {};
      },
      setInterfaceLocale: () => {},
      onQuitRequested: () => () => {},
      onQuitProgress: () => () => {},
      onPreviewEvent: () => () => {},
      onUpdate: () => () => {},
      onNotificationOpen: () => () => {},
      onMcpAppDeepLink: () => () => {},
      onMcpAppEvent: () => () => {},
      presentReady: async () => {},
      preview: async () => ({}),
      command: async (name, params) => {
        if (["connect", "list", "open"].includes(name))
          return { ok: true, value: structuredClone(window.fixtureSnapshot) };
        if (name === "bugReport") {
          if (params.operation === "prepare")
            return {
              ok: true,
              value: {
                token: "11111111-1111-4111-8111-111111111111",
                diagnostics: "fixture diagnostic preview",
              },
            };
          if (params.operation === "save") {
            if (window.failSave) {
              window.failSave = false;
              return { ok: false, error: { code: "SAVE_FAILED", message: "fixture failure" } };
            }
            window.bugReports[params.id] = {
              ...params,
              schemaVersion: 1,
              state: "local-only",
              createdAt: new Date().toISOString(),
              diagnostics: params.diagnosticsToken ? "fixture diagnostic preview" : null,
            };
            return { ok: true, value: { id: params.id } };
          }
          if (params.operation === "read")
            return { ok: true, value: { report: window.bugReports[params.id] } };
          if (params.operation === "list")
            return {
              ok: true,
              value: {
                reports: Object.values(window.bugReports).map((r) => ({
                  id: r.id,
                  createdAt: r.createdAt,
                  screenshotCount: r.screenshots.length,
                  hasDiagnostics: !!r.diagnostics,
                })),
              },
            };
          if (params.operation === "delete") {
            delete window.bugReports[params.id];
            return { ok: true, value: { deleted: true } };
          }
          if (params.operation === "export") return { ok: true, value: { canceled: true } };
        }
        return { ok: true, value: { data: [], projects: [], pendingApply: false } };
      },
    };
  });
  await page.goto(origin);
  await page.getByTestId("areal-workbench").waitFor();
  await page.getByRole("button", { name: "任务操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "反馈问题" }).click();
  const dialog = page.locator(".bug-report-dialog");
  await dialog.waitFor();
  const save = dialog.getByRole("button", { name: "保存到本机" });
  assert.equal(await save.isDisabled(), true);
  const description = dialog.getByLabel("问题描述");
  await description.fill("重现问题：打开测试页面。");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "任务操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "反馈问题" }).click();
  assert.equal(await description.inputValue(), "重现问题：打开测试页面。");
  const png = Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 8;
      c.height = 8;
      c.getContext("2d").fillRect(0, 0, 8, 8);
      return c.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  await dialog
    .locator("input[type=file]")
    .setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: png });
  await dialog.getByRole("img", { name: "反馈截图 1" }).waitFor();
  await dialog.getByRole("button", { name: "移除截图 1" }).click();
  assert.equal(await dialog.getByRole("img").count(), 0);
  await dialog
    .locator("input[type=file]")
    .setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: png });
  await dialog.getByRole("img", { name: "反馈截图 1" }).waitFor();
  await dialog.evaluate(
    (element, bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }));
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true }),
      );
    },
    [...png],
  );
  await dialog.getByRole("img", { name: "反馈截图 2" }).waitFor();
  await dialog.getByRole("button", { name: "移除截图 2" }).click();
  await dialog.locator(".bug-report-images").evaluate(
    (element, bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], "dropped.png", { type: "image/png" }));
      element.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true }));
    },
    [...png],
  );
  await dialog.getByRole("img", { name: "反馈截图 2" }).waitFor();
  await dialog.getByRole("button", { name: "移除截图 2" }).click();
  await dialog.getByRole("button", { name: "反馈截图 1" }).click();
  assert.equal(await dialog.locator(".bug-report-expanded-image").count(), 1);
  await dialog.getByRole("button", { name: "反馈截图 1" }).click();
  assert.equal(await dialog.locator(".bug-report-expanded-image").count(), 0);
  const checkbox = dialog.getByRole("switch", { name: "附带诊断上下文" });
  assert.equal(await checkbox.isChecked(), false);
  await checkbox.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('.bug-report-consent [role="switch"]')
        ?.getAttribute("aria-checked") === "true",
  );
  await dialog.getByText("查看将附带的诊断内容").click();
  await dialog.getByText("fixture diagnostic preview").waitFor();
  await page.screenshot({ path: join(evidence, "zh-light.png"), animations: "disabled" });
  await save.click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(await description.inputValue(), "重现问题：打开测试页面。");
  assert.equal(await dialog.getByRole("img").count(), 1);
  await save.click();
  await dialog.getByText("已保存到本机，尚未发送。请检查内容后导出。").waitFor();
  const saved = await page.evaluate(() => Object.values(window.bugReports)[0]);
  assert.equal(saved.diagnosticsToken, "11111111-1111-4111-8111-111111111111");
  assert.ok(saved.screenshots[0].startsWith("data:image/png;base64,"));
  await dialog.getByRole("button", { name: "导出反馈包" }).click();
  assert.equal(await dialog.getByText("反馈包已导出，尚未发送。").count(), 0);
  await dialog.getByRole("button", { name: "本机反馈", exact: true }).click();
  await dialog.getByRole("button", { name: "查看反馈" }).click();
  await dialog.getByRole("button", { name: "删除本机反馈" }).click();
  await dialog.getByRole("button", { name: "确认删除" }).click();
  await dialog.getByText("暂无本机反馈").waitFor();
  checks.push(
    "empty description, close/reopen draft retention and deletion clears draft, screenshot selection/removal/preview, synthetic paste/drop, diagnostics preview, save failure retention, save, canceled export, history and deletion",
  );
  await dialog.getByRole("button", { name: "返回填写" }).click();
  assert.equal(await description.inputValue(), "");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(evidence, "zh-narrow.png"), animations: "disabled" });
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.evaluate(() => {
    const value = JSON.stringify({ locale: "en" });
    localStorage.setItem("areal-gui:application-preferences", value);
    window.dispatchEvent(
      new StorageEvent("storage", { key: "areal-gui:application-preferences", newValue: value }),
    );
    window.setFixtureTheme({ platform: "darwin", dark: true, id: "dark" });
  });
  await dialog.getByText("Report a bug", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Save locally" }).waitFor();
  await page.screenshot({ path: join(evidence, "en-dark-narrow.png"), animations: "disabled" });
  checks.push("English and dark theme in narrow viewport");
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  if (!passed && page)
    await page.screenshot({ path: join(evidence, "failure.png"), animations: "disabled" });
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        scope: "Browser fixture bridge; no Electron IPC or Core",
        sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: gui,
          encoding: "utf8",
        }).trim(),
        dirty: execFileSync("git", ["status", "--short"], { cwd: gui, encoding: "utf8" }).trim(),
        viewports: ["1400x1000 light zh-CN", "390x844 light zh-CN", "390x844 dark en"],
      },
      null,
      2,
    ),
  );
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log(JSON.stringify({ passed, checks, evidence }, null, 2));
