import { until } from "./support/desktop-fixture.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createReadingFixture } from "./conversation-reading-fixture.mjs";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const evidence = resolve(process.env.AREAL_DETAIL_EVIDENCE || ".scratch/tool-details-ux");
await mkdir(evidence, { recursive: true });
const fixture = await createReadingFixture({ deferredTools: true });
const report = {
  passed: false,
  scope: fixture.snapshot().scope,
  revision: fixture.snapshot().revision,
  checks: [],
  errors: [],
};
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.AREAL_GUI_TEST_BROWSER
      ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER }
      : { channel: "chrome" }),
  });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 800 },
    serviceWorkers: "block",
  });
  const origin = new URL(fixture.url).origin;
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto(fixture.url);
  await page.getByText("Live output.", { exact: true }).waitFor();
  const group = page.locator('[data-turn-id="old-base"] .turn-progress').first();
  const groupSummary = group.locator(".turn-progress-summary");
  if ((await groupSummary.getAttribute("aria-expanded")) !== "true") await groupSummary.click();
  const activity = group
    .locator('[data-tool-id="tool-base"]')
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " areal-activity-group ")][1]',
    )
    .locator(".areal-disclosure-trigger")
    .first();
  if ((await activity.getAttribute("aria-expanded")) !== "true") await activity.click();
  const tool = group.locator('[data-tool-id="tool-base"]');
  await tool.waitFor();
  assert.equal(
    fixture.snapshot().detailCalls.length,
    0,
    "opening group must not load closed tool bodies",
  );
  assert.equal(await group.locator("[data-history-item-id]").count(), 0);
  assert.equal(await group.getByRole("button", { name: /加载完整内容|load full/i }).count(), 0);
  await group.evaluate((node) => {
    node.dataset.detailProbe = "preserved";
  });
  await tool.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/desktop-closed.png` });
  const control = (operation) =>
    page.evaluate(
      (operation) =>
        fetch("/__reading/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operation }),
        }),
      operation,
    );
  await control("hold");
  const summary = tool.locator(".tool-summary-row");
  await summary.click();
  await page.waitForFunction(() =>
    document.querySelector('[data-tool-id="tool-base"] [aria-busy="true"]'),
  );
  await until(
    () => page.evaluate(async () => (await (await fetch("/__reading/state")).json()).pending === 1),
    "tool detail request held",
  );
  assert.equal(fixture.snapshot().detailCalls.length, 1);
  assert.equal(await summary.getAttribute("aria-expanded"), "true");
  await control("release");
  await tool.getByText("Result base", { exact: false }).waitFor();
  assert.equal(await group.getAttribute("data-detail-probe"), "preserved");
  assert.equal(fixture.snapshot().detailCalls.length, 1);
  report.checks.push(
    "group expansion leaves closed bodies unloaded; first click loads result and preserves group",
  );
  await summary.focus();
  await page.keyboard.press("Enter");
  assert.equal(await summary.getAttribute("aria-expanded"), "false");
  await page.keyboard.press("Space");
  assert.equal(await summary.getAttribute("aria-expanded"), "true");
  assert.equal(fixture.snapshot().detailCalls.length, 1);
  report.checks.push("keyboard closes and opens loaded detail without another request");
  const second = group.locator('[data-tool-id="tool-second-base"]');
  await control("failNext");
  await second.locator(".tool-summary-row").click();
  const alert = second.getByRole("alert");
  await alert.waitFor();
  assert.equal(await second.locator(".tool-summary-row").getAttribute("aria-expanded"), "true");
  await second.getByRole("button", { name: /重试|retry/i }).click();
  await second.getByText("Second result base", { exact: false }).waitFor();
  report.checks.push("failed detail shows local retry and succeeds");
  await page.setViewportSize({ width: 620, height: 800 });
  await second.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/compact-open.png` });
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.errors.push(error.stack || String(error));
} finally {
  await browser?.close();
  await fixture.close();
  await writeFile(`${evidence}/fixture-report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
