import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");
const dist = join(gui, "renderer/dist");
const evidence = process.env.AREAL_FEEDBACK_EVIDENCE_DIR || join(gui, "../../out/feedback-ui");
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
    window.calls = [];
    window.drafts = {};
    window.available = true;
    window.optedIn = true;
    let nativeStateListener;
    const readNativeState = () => structuredClone(window.fixtureSnapshot);
    window.publish = () => nativeStateListener?.(readNativeState());
    window.finishPolish = () => {
      const side = project.state.threads.side;
      side.turns.at(-1).status = "completed";
      side.turns.at(-1).items = [
        {
          id: "polished",
          type: "agentMessage",
          phase: "final_answer",
          text: "用户指出旧接口兼容性没有得到验证，应补充兼容性检查，并区分已完成内容与待验证内容。",
        },
      ];
      window.publish();
    };
    window.arealDesktop = {
      nativeState: async () => readNativeState(),
      onNativeState: (listener) => {
        nativeStateListener = listener;
        return () => {};
      },
      theme: async () => ({ platform: "darwin", dark: false, id: "light" }),
      onTheme: () => () => {},
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
        window.calls.push({ name, params });
        if (["connect", "list", "open"].includes(name))
          return { ok: true, value: structuredClone(window.fixtureSnapshot) };
        if (name === "trajectory")
          return {
            ok: true,
            value: {
              enabled: false,
              state: "disabled",
              endpoint: "",
              configPath: null,
              spool_dir: "/fixture",
              worker_running: false,
              queue: {
                pending: 0,
                uploading: 0,
                failed: 0,
                uploaded: 0,
                evicted: 0,
                bytes: 0,
                max_bytes: 1024,
                dropped_memory: 0,
                dropped_oversize: 0,
              },
              records: [],
              last_error: null,
              last_success_at: null,
              limits: { max_retries: 1, upload_interval_ms: 1000, max_memory_bytes: 1024 },
            },
          };
        if (name === "feedback") {
          if (params.operation === "status")
            return {
              ok: true,
              value: {
                enabled: window.available,
                connected: window.available,
                opted_in: window.optedIn,
                installation: null,
                account: null,
                destination: null,
              },
            };
          if (params.operation === "preference") {
            window.optedIn = params.enabled;
            return {
              ok: true,
              value: {
                enabled: window.available,
                connected: window.available,
                opted_in: window.optedIn,
                installation: null,
                account: null,
                destination: null,
              },
            };
          }
          if (params.operation === "prepare") {
            const draft = {
              id: crypto.randomUUID(),
              projectId: params.projectId,
              threadId: params.threadId,
              turnId: params.turnId,
              itemId: params.itemId,
              rating: params.rating,
              reason: "",
              analysis: "",
              state: "draft",
              contextSha256: "fixture-context",
              createdAt: Date.now(),
              submissionUnknown: false,
            };
            window.drafts[draft.id] = draft;
            return { ok: true, value: structuredClone(draft) };
          }
          const draft = window.drafts[params.id];
          if (params.operation === "draft") {
            Object.assign(draft, {
              rating: params.rating,
              reason: params.reason,
              analysis: params.analysis,
            });
            return { ok: true, value: structuredClone(draft) };
          }
          if (params.operation === "refine") {
            draft.sideThreadId = "side";
            project.state.threads.side = {
              id: "side",
              conversation: { kind: "side", origin: { sourceThreadId: "main" } },
              turns: [{ id: "refine", status: "inProgress", items: [] }],
            };
            window.publish();
            return { ok: true, value: structuredClone(draft) };
          }
          if (params.operation === "submit") {
            Object.assign(draft, {
              state: "submitted",
              reason: params.reason,
              analysis: params.analysis,
            });
            return { ok: true, value: structuredClone(draft) };
          }
          return { ok: true, value: structuredClone(draft) };
        }
        if (name === "send") {
          turns.push({
            id: "continued",
            status: "completed",
            items: [
              {
                id: "q2",
                type: "userMessage",
                content: [{ type: "text", text: params.text || "主任务继续" }],
              },
              { id: "a2", type: "agentMessage", phase: "final_answer", text: "主任务继续完成。" },
            ],
          });
          window.publish();
          return { ok: true, value: { threadId: "main", turn: structuredClone(turns.at(-1)) } };
        }
        return { ok: true, value: { data: [], projects: [], pendingApply: false } };
      },
    };
  });
  await page.goto(origin);
  await page.getByTestId("areal-workbench").waitFor();
  const vote = page
    .locator('[data-turn-id="rated"]')
    .getByRole("button", { name: "点踩", exact: true });
  await vote.scrollIntoViewIfNeeded();
  await vote.click({ force: true });
  const panel = page.getByRole("dialog", { name: "点踩反馈" });
  await panel.waitFor();
  const reason = panel.getByLabel("你的理由");
  await reason.fill("没有确认旧接口是否兼容，希望指出待验证项。");
  assert.equal(
    await page.evaluate(
      () =>
        window.calls.filter((x) => x.name === "feedback" && x.params.operation === "submit").length,
    ),
    0,
  );
  checks.push("vote opens optional draft without publishing");
  await page.screenshot({ path: join(evidence, "feedback-reason.png"), animations: "disabled" });
  const scroller = page.locator(".messages");
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.waitForTimeout(150);
  assert.equal(await panel.isVisible(), false);
  await vote.scrollIntoViewIfNeeded();
  await panel.waitFor();
  assert.equal(await reason.inputValue(), "没有确认旧接口是否兼容，希望指出待验证项。");
  checks.push("scroll away hides anchored panel; returning restores reason");
  await panel.getByRole("button", { name: "Agent 润色", exact: true }).click();
  await panel.getByText("正在理解你的意见…").waitFor();
  const composer = page.getByTestId("chat-input");
  await composer.fill("主任务继续");
  await composer.press("Enter");
  await page.waitForFunction(() =>
    window.calls.some((x) => x.name === "send" && x.params.threadId === "main"),
  );
  assert.equal(
    await page.evaluate(
      () => window.fixtureSnapshot.projects[0].state.threads.side.turns[0].status,
    ),
    "inProgress",
  );
  checks.push("main conversation sends while independent polishing is still running");
  await vote.scrollIntoViewIfNeeded();
  await panel.waitFor();
  await page.evaluate(() => window.finishPolish());
  await page.waitForFunction(() =>
    document.querySelector('.user-feedback-panel textarea[rows="5"]')?.value.includes("兼容性"),
  );
  await page.screenshot({ path: join(evidence, "feedback-polished.png"), animations: "disabled" });
  await panel.getByLabel("提交的分析").fill("我确认：兼容性需要单独验证，不能只报告新接口已完成。");
  await panel.getByRole("button", { name: "提交评价", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  const sent = await page.evaluate(
    () =>
      window.calls.filter((x) => x.name === "feedback" && x.params.operation === "submit").at(-1)
        .params,
  );
  assert.equal(sent.rating, "down");
  assert.match(sent.analysis, /我确认/);
  checks.push("user can edit analysis and explicitly submit");
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await vote.scrollIntoViewIfNeeded();
  await vote.click({ force: true });
  await panel.waitFor();
  const bounds = await panel.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  const composerBounds = await composer.boundingBox();
  assert.ok(
    bounds.y + bounds.height < composerBounds.y,
    "anchored panel leaves the main composer available on narrow screens",
  );
  await composer.click();
  await composer.fill("窄窗口仍可继续输入");
  await page.screenshot({ path: join(evidence, "feedback-narrow.png"), animations: "disabled" });
  await composer.fill("");
  await panel.getByRole("button", { name: "关闭评价" }).click();
  assert.equal(await panel.isVisible(), false);
  checks.push("narrow layout fits and explicit close dismisses panel");
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "数据飞轮", exact: true }).click();
  await page.getByRole("switch", { name: "显示点赞和点踩", exact: true }).click();
  await page.waitForFunction(() => window.optedIn === false);
  await page.screenshot({
    path: join(evidence, "feedback-preference.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".user-feedback-anchor button"));
  checks.push("the user can opt out in settings without disabling trajectory export");
  await page.evaluate(() => {
    window.optedIn = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await vote.waitFor();
  await page.evaluate(() => {
    window.available = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(() => !document.querySelector(".user-feedback-anchor button"));
  checks.push("an unavailable feedback receiver hides all vote controls");
  assert.deepEqual(errors, []);
  passed = true;
  await writeFile(
    join(evidence, "calls.json"),
    JSON.stringify(await page.evaluate(() => window.calls), null, 2),
  );
} finally {
  if (!passed && page) {
    await page.screenshot({ path: join(evidence, "failure.png"), animations: "disabled" });
    await writeFile(
      join(evidence, "failure-state.json"),
      JSON.stringify(
        await page.evaluate(() => ({
          calls: window.calls,
          body: document.body.innerText,
          project: window.fixtureSnapshot.projects[0],
        })),
        null,
        2,
      ),
    );
  }
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({ passed, checks, errors }, null, 2) + "\n",
  );
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log(JSON.stringify({ passed, checks, evidence }, null, 2));
