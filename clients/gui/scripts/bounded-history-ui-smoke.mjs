import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createReadingFixture } from "./conversation-reading-fixture.mjs";
import { makeTempDir } from "./support/temp.mjs";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const locale = process.env.AREAL_HISTORY_UI_LOCALE || "zh-CN";
const en = locale === "en";
const labels = {
  older: en ? "Load older messages" : "加载更早的消息",
  olderLoading: en ? "Loading older messages…" : "正在加载更早的消息…",
  full: en ? "Load full content" : "加载完整内容",
  retry: en ? "Retry loading conversation" : "重试加载对话",
  failed: en ? "Could not load history. Please try again." : "历史内容加载失败，请重试。",
};
const evidence = await makeTempDir("areal-history-ui-");
const fixture = await createReadingFixture({ pageCount: 25 });
const report = { passed: false, locale, evidence, checks: [], errors: [] };
const user = (id, text) => ({ id, type: "userMessage", content: [{ type: "text", text }] });
const agent = (id, text) => ({ id, type: "agentMessage", phase: "final_answer", text });
let browser, page;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.AREAL_GUI_TEST_BROWSER
      ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER }
      : { channel: "chrome" }),
  });
  const open = async () => {
    const next = await browser.newPage({
      viewport: { width: 1280, height: 960 },
      serviceWorkers: "block",
    });
    next.on("pageerror", (error) => report.errors.push(error.message));
    const origin = new URL(fixture.url).origin;
    await next.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await next.addInitScript((locale) => {
      localStorage.setItem("areal-gui:application-preferences", JSON.stringify({ locale }));
    }, locale);
    await next.goto(fixture.url);
    return next;
  };
  page = await open();
  await page.getByText("Live output.", { exact: true }).waitFor();
  const frames = () =>
    page.evaluate(async () => {
      await document.fonts.ready;
      for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
    });
  const control = async (operation) => {
    const response = await fetch(new URL("/__reading/control", fixture.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation }),
    });
    assert.ok(response.ok, await response.text());
  };
  const history = (history, turns) => ({
    thread: { id: "reading-thread", status: "idle", turns },
    history,
  });
  const completed = (id, items) => ({ id, status: "completed", items });
  const olderPage = async () => {
    await messages.evaluate((element) => {
      element.scrollTop = 0;
    });
    await messages.focus();
    await page.waitForFunction(() => document.querySelector(".messages")?.scrollTop === 0);
    await page.keyboard.press("PageUp");
  };
  const pending = (count) =>
    page.waitForFunction(
      (count) =>
        Number(
          document.querySelector("[data-fixture-history-calls]")?.dataset.fixtureHistoryCalls,
        ) >= count,
      count,
    );
  const head = completed("latest", [user("latest-user", "LATEST_USER_SENTINEL")]);
  const original = agent("deferred", "COMPLETE_UNICODE_雪🙂_SENTINEL");
  const normal = fixture.defer(head, original);
  const large = fixture.defer(head, agent("oversized", "Never substitute a partial reply"), {
    oversized: true,
  });
  fixture.replaceObservation(
    history({ snapshotId: "deferred-fixture", nextCursor: null, complete: true }, [
      { ...head, items: [...head.items, normal, large] },
    ]),
  );
  const details = page.locator('[data-history-item-id="deferred"]');
  const oversized = page.locator('[data-history-item-id="oversized"]');
  await details.waitFor();
  await oversized.getByText(/70/).waitFor();
  assert.equal(fixture.snapshot().calls, 0, "deferred bodies are not fetched until requested");

  await control("hold");
  await details.getByRole("button", { name: labels.full, exact: true }).click();
  await pending(1);
  assert.equal(fixture.snapshot().pending, 1);
  assert.equal(await page.getByText(original.text, { exact: true }).count(), 0);
  await control("release");
  await page.getByText(original.text, { exact: true }).waitFor();
  assert.equal(await details.count(), 0);
  assert.equal(fixture.snapshot().detailCalls[0].params.cursor, normal.cursor);

  await oversized.getByRole("button", { name: labels.full, exact: true }).click();
  await oversized.getByRole("alert").filter({ hasText: labels.failed }).waitFor();
  assert.equal(
    fixture.snapshot().calls,
    1,
    "oversized display is rejected before reading fragments",
  );
  report.checks.push(
    "explicit Host fragments restore the full Unicode body and enforce the display limit",
  );

  // 两个独立阅读场景各用自己的视图，分页不继承正文读取保存的位置。
  await page.close();
  const tail = completed("tail", [
    user("tail-user", "ORIGINAL_PAGE_ANCHOR"),
    agent(
      "tail-answer",
      Array.from({ length: 40 }, (_, index) => `Latest paragraph ${index}.`).join("\n\n"),
    ),
  ]);
  fixture.replaceObservation(
    history({ snapshotId: "paging-fixture", nextCursor: "page:0", complete: false }, [tail]),
  );
  page = await open();
  let messages = page.locator(".messages");
  const status = page.locator(".message-history-controls [role=status]");
  const anchor = page.locator('[data-side-item-id="tail-user"] .conversation-markdown');
  await anchor.waitFor();
  assert.equal(await page.getByRole("button", { name: labels.older, exact: true }).count(), 0);
  await control("hold");
  await olderPage();
  await pending(2);
  assert.deepEqual(fixture.snapshot().held, [{ cursor: "page:0" }]);
  await page.waitForFunction(() => {
    const views = JSON.parse(sessionStorage.getItem("areal-gui:reading-views:v1") ?? "null");
    return views?.views?.[0]?.position?.anchor;
  });
  const point = await page.evaluate(() => {
    const views = JSON.parse(sessionStorage.getItem("areal-gui:reading-views:v1") ?? "null");
    return views?.views?.[0]?.position?.anchor;
  });
  assert.ok(point?.itemId, "the original reader has a saved anchor before the page resolves");
  const anchoredItem = page.locator(`[data-side-item-id="${point.itemId}"]`);
  const anchoredBlock =
    point.blockIndex == null
      ? anchoredItem
      : anchoredItem.locator(".conversation-markdown > *").nth(point.blockIndex);
  const anchorTop = () =>
    anchoredBlock.evaluate(
      (node) =>
        node.getBoundingClientRect().top - node.closest(".messages").getBoundingClientRect().top,
    );
  const before = await anchorTop();
  assert.ok(
    Math.abs(before - point.offset) <= 2,
    "measured reader offset matches the saved anchor",
  );
  assert.equal(await status.count(), 0);
  assert.equal(await page.getByText(labels.olderLoading, { exact: true }).count(), 0);
  await control("release");
  await page.locator('[data-side-item-id="answer-0"]').waitFor({ state: "attached" });
  await frames();
  const after = await anchorTop();
  report.anchor = { point, before, after };
  assert.ok(Math.abs(after - before) <= 2, "anchor stays within 2 px after prepend");
  report.checks.push("keyboard pagination is silent and preserves the message anchor on prepend");

  await control("failNext");
  await olderPage();
  await page.getByText(labels.failed, { exact: true }).waitFor();
  assert.equal(fixture.snapshot().failures, 1);
  await page.getByRole("button", { name: labels.retry, exact: true }).click();
  await page.locator('[data-side-item-id="answer-1"]').waitFor({ state: "attached" });
  assert.equal(await page.getByText(labels.failed, { exact: true }).count(), 0);
  assert.equal(fixture.snapshot().calls, 4);
  assert.deepEqual(fixture.snapshot().cursors.slice(-2), ["page:1", "page:1"]);
  report.checks.push("retry after a failed read restores the original page");

  for (let index = 2; index < 20; index++) {
    await olderPage();
    await page.locator(`[data-side-item-id="answer-${index}"]`).waitFor({ state: "attached" });
    await frames();
  }
  const pages = page.locator('[data-side-item-id^="answer-"]');
  assert.ok((await pages.count()) <= 16);
  const gap = page.locator("[data-history-page-id]").first();
  await gap.waitFor();
  const beforeGap = fixture.snapshot().calls;
  await gap.getByRole("button").click();
  await pending(beforeGap + 1);
  await page.waitForFunction(() => {
    const data = document.querySelector("[data-fixture-history]")?.dataset.fixtureHistory;
    return data && !JSON.parse(data).loadingOlder;
  });
  assert.equal(fixture.snapshot().calls, beforeGap + 1);
  assert.ok((await pages.count()) <= 16);
  assert.equal(await anchor.count(), 1);
  await page.screenshot({ path: join(evidence, "paging-gap.png"), animations: "disabled" });
  report.checks.push("resident pages stay bounded and clicking a gap reloads one page");

  const turns = Array.from({ length: 30 }, (_, index) =>
    completed(`ordinary-${index}`, [
      user(`ordinary-user-${index}`, `ORDINARY_USER_${index}`),
      agent(`ordinary-answer-${index}`, `ORDINARY_ANSWER_${index}`),
    ]),
  );
  fixture.replaceObservation(
    history({ snapshotId: "complete-fixture", nextCursor: null, complete: true }, turns),
  );
  await page.getByText("ORDINARY_ANSWER_29", { exact: true }).waitFor();
  const beforeWheel = fixture.snapshot().calls;
  await messages.hover();
  for (const delta of [-500, 500]) {
    for (let index = 0; index < 20; index++) await page.mouse.wheel(0, delta);
    assert.equal(await page.locator('[data-side-item-id^="ordinary-answer-"]').count(), 30);
    assert.equal(await page.locator('[data-side-item-id^="ordinary-user-"]').count(), 30);
  }
  assert.equal(fixture.snapshot().calls, beforeWheel);
  report.checks.push(
    "complete thirty-turn history stays present without additional reads on wheel input",
  );

  await page.close();
  fixture.replaceObservation(
    history({ snapshotId: "short-fixture", nextCursor: "page:0", complete: false }, [
      completed("short-tail", [agent("short-latest", "Short latest reply.")]),
    ]),
    { concise: true },
  );
  page = await open();
  messages = page.locator(".messages");
  await page.getByText("Short latest reply.", { exact: true }).waitFor();
  await messages.hover();
  const beforeBurst = fixture.snapshot().calls;
  await control("hold");
  await olderPage();
  await pending(beforeBurst + 1);
  for (let index = 0; index < 3; index++) await page.mouse.wheel(0, -3);
  assert.equal(
    fixture.snapshot().calls,
    beforeBurst + 1,
    "the held read is the only in-flight page",
  );
  await control("release");
  await page.getByText("Short older reply 1.", { exact: true }).waitFor();
  await frames();
  assert.equal(fixture.snapshot().calls, beforeBurst + 2, "the burst queues only one further read");
  assert.ok(await messages.evaluate((node) => node.scrollHeight <= node.clientHeight));

  await control("hold");
  await olderPage();
  await pending(beforeBurst + 3);
  await page.mouse.wheel(0, -3);
  await page.mouse.wheel(0, 15);
  await control("release");
  await page.getByText("Short older reply 2.", { exact: true }).waitFor();
  await frames();
  assert.equal(fixture.snapshot().calls, beforeBurst + 3, "downward input revokes the queued read");
  report.checks.push("busy upward input queues one page, and downward input cancels it");
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.errors.push(error.stack ?? String(error));
  if (page)
    report.body = await page
      .locator("body")
      .innerText()
      .catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await fixture.close();
  await writeFile(
    join(evidence, "manifest.json"),
    JSON.stringify(
      {
        ...report,
        ...fixture.snapshot(),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(report));
}
