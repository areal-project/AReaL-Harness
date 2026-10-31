// 对话流 v2 的浏览器回归：末尾状态单行（CONV-STATUS-01）、阶段分组与计数、失败留在原位
// （CONV-ACTIVITY-01）、回合完成收起时的阅读锚点。运行前需 `pnpm design:build`。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");
const dist = process.env.AREAL_DESIGN_DIST || join(gui, "dist/design-system");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".png": "image/png",
};
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://local").pathname);
    const path = resolve(dist, pathname === "/" ? "design-system.html" : `.${pathname}`);
    if (!path.startsWith(dist + sep)) throw new Error("Invalid asset path");
    response.setHeader("Content-Type", types[extname(path)] ?? "application/octet-stream");
    response.end(await readFile(path));
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const checks = [];
const errors = [];
let browser;
let passed = false;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.AREAL_GUI_TEST_BROWSER
      ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER }
      : { channel: "chrome" }),
  });
  const open = async (query, viewport = { width: 1200, height: 900 }) => {
    const page = await browser.newPage({ viewport, serviceWorkers: "block" });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/design-system.html${query}`, { waitUntil: "networkidle" });
    return page;
  };

  // 时间线只展示 Core 事实；没有工具也保留中断分隔行。
  {
    const page = await open("");
    const reading = page.locator("#activity-reading-preview");
    await reading.getByLabel("活动形状", { exact: true }).selectOption("empty");
    assert.equal(await reading.locator("[data-model-change]").count(), 2);
    await reading.getByRole("button", { name: "接受新轮次", exact: true }).click();
    const user = reading.locator(".user-message");
    await user.waitFor();
    await page.waitForTimeout(200);
    const inset = await user.evaluate((element) => {
      const viewport = element.closest(".messages");
      return element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    });
    assert.ok(inset >= -1 && inset < 80, `accepted user starts near top: ${inset}`);
    const time = user.getByRole("button", { name: /消息时间/ });
    await time.focus();
    assert.equal(await time.evaluate((element) => getComputedStyle(element).opacity), "1");
    assert.ok((await time.getAttribute("aria-label")).includes("2026"));
    for (const [state, expected] of [
      ["paused", "你暂停了本轮执行"],
      ["recovery", "Core 恢复时中断了本轮执行"],
      ["waiting", "正在等待重试"],
      ["recovered", "连接已恢复"],
      ["exhausted", "重试额度已耗尽"],
      ["otherFailure", "重试已停止"],
    ]) {
      await reading.getByLabel("活动状态", { exact: true }).selectOption(state);
      await reading.getByText(expected, { exact: false }).waitFor();
      if (state !== "exhausted")
        assert.equal(await reading.locator('[data-retry-state="exhausted"]').count(), 0);
    }
    await reading.getByLabel("活动状态", { exact: true }).selectOption("running");
    const messages = reading.locator(".messages").first();
    await messages.hover();
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(150);
    const before = await messages.evaluate((element) => element.scrollTop);
    await reading.getByRole("button", { name: "延迟追加输出", exact: true }).click();
    await page.waitForTimeout(400);
    assert.ok(
      Math.abs((await messages.evaluate((element) => element.scrollTop)) - before) < 2,
      "manual reading yields the turn-start target during output",
    );
    checks.push(
      "timeline facts distinguish no-tool interruption, retry outcomes, model changes, keyboard time and accepted-message anchor",
    );
    await page.close();
  }

  // 末尾实时状态：12 行运行中命令只显示一行摘要。
  {
    const page = await open("");
    const reading = page.locator("#activity-reading-preview");
    await reading.getByRole("button", { name: "接受新轮次", exact: true }).click();
    for (const shape of ["single", "grouped", "multiple"]) {
      await reading.getByLabel("活动形状", { exact: true }).selectOption(shape);
      const tail = reading.locator(".turn-activity");
      await tail.waitFor();
      const size = await tail.evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        line: parseFloat(getComputedStyle(el.firstElementChild).lineHeight),
        text: el.querySelector('[role="status"]')?.textContent ?? "",
      }));
      assert.ok(
        size.height <= size.line + 1,
        `${shape}: tail is one line (${JSON.stringify(size)})`,
      );
      assert.ok(
        !size.text.includes("command line 2"),
        `${shape}: tail shows only the command summary`,
      );
    }
    checks.push("running multi-line command keeps the turn tail to one line with only its summary");
    await page.close();
  }

  // 阶段分组、计数与失败行。
  {
    const page = await open("?conversation");
    const timeline = page.locator("#conversation-timeline");
    const turn = timeline.locator('[data-turn-id="timeline-turn"]');
    const summary = turn.locator(".turn-progress-summary").first();
    await summary.waitFor();
    if ((await summary.getAttribute("aria-expanded")) !== "true") await summary.click();
    const failedGroup = turn.getByRole("button", {
      name: "已修改 7 个文件，已运行命令 · 1 个失败",
      exact: true,
    });
    await failedGroup.click();
    await turn.locator('[data-tool-id="timeline-command-failed"]').waitFor();
    const labels = await turn
      .locator(".turn-execution .areal-activity-group > .areal-disclosure > button")
      .allInnerTexts();
    assert.ok(
      labels.some((label) => label.includes("已探索") && !/已探索[^，]*\d+ 个文件/.test(label)),
      `exploration title omits file counts: ${labels}`,
    );
    assert.ok(
      labels.some((label) => label.includes("已修改 7 个文件")),
      `change title counts files: ${labels}`,
    );
    const failed = turn.locator('[data-tool-id="timeline-command-failed"]');
    await failed.getByRole("button", { name: /失败 · exit 1/ }).waitFor();
    assert.equal(await summary.locator("svg.lucide-circle-alert").count(), 0);
    checks.push(
      "activity groups count completed steps by stage; a failed step stays in place with its exit code",
    );
    await page.close();
  }

  // 回合完成自动收起：跟随底部继续跟随；阅读中的读者以过程标题为锚，最终回答从首行可见。
  const settle = async (scrollUp, viewport) => {
    const page = await open("?conversation", viewport);
    const timeline = page.locator("#conversation-timeline");
    await timeline.getByRole("button", { name: "显示执行中", exact: true }).click();
    await page.waitForTimeout(800);
    const messages = timeline.locator(".messages");
    await messages.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page.waitForTimeout(300);
    assert.ok(
      await messages.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 2),
      "reader starts at the tail of the running turn",
    );
    if (scrollUp) {
      await messages.hover();
      await page.mouse.wheel(0, -scrollUp);
      await page.waitForTimeout(300);
    }
    const before = await messages.evaluate((el) => el.scrollTop);
    await timeline.getByRole("button", { name: "显示已完成", exact: true }).click();
    await page.waitForTimeout(600);
    const after = await messages.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const final = [...el.querySelectorAll(".assistant-message")].findLast(
        (node) => node.getAttribute("data-message-phase") !== "commentary",
      );
      return {
        scrollTop: el.scrollTop,
        atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 2,
        finalTop: final ? final.getBoundingClientRect().top - box.top : null,
        client: el.clientHeight,
      };
    });
    await page.close();
    return { before, after };
  };
  const follow = await settle(0);
  assert.ok(follow.after.atBottom, `following reader stays at the tail: ${JSON.stringify(follow)}`);
  const near = await settle(500);
  assert.ok(
    Math.abs(near.after.scrollTop - near.before) <= 1,
    `reader near the top keeps position: ${JSON.stringify(near)}`,
  );
  const middle = await settle(260, { width: 1200, height: 640 });
  assert.ok(
    middle.after.finalTop !== null &&
      middle.after.finalTop >= 0 &&
      middle.after.finalTop < middle.after.client / 2,
    `reader inside the process sees the final answer from its first line: ${JSON.stringify(middle)}`,
  );
  checks.push(
    "settling collapse keeps followers at the tail, keeps readers near the top, and anchors readers inside the process to the final answer start",
  );

  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  console.log(JSON.stringify({ passed, checks, errors }));
}
