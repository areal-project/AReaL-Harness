import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createReadingFixture } from "./conversation-reading-fixture.mjs";
import { makeTempDir } from "./support/temp.mjs";
const require = createRequire(new URL("../app/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const evidence = await makeTempDir("areal-reading-continuity-");
const fixture = await createReadingFixture();
const dirtyFiles = execFileSync("git", ["ls-files", "-m", "-o", "--exclude-standard"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter((path) => path.startsWith("clients/gui/"));
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      dirtyFiles.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  );
const sourceHashes = await hashes();
let browser;
let page;
const report = {
  passed: false,
  evidence,
  scope: fixture.snapshot().scope,
  revision: fixture.snapshot().revision,
  sourceHashes,
  checks: [],
  errors: [],
};
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.AREAL_GUI_TEST_BROWSER
      ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER }
      : { channel: "chrome" }),
  });
  page = await browser.newPage({ viewport: { width: 1100, height: 800 }, serviceWorkers: "block" });
  const origin = new URL(fixture.url).origin;
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto(fixture.url);
  await page.getByText("Live output.", { exact: true }).waitFor();
  report.environment = {
    browser: browser.version(),
    ...(await page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight },
      dpr: devicePixelRatio,
      font: getComputedStyle(document.body).font,
      initialTheme: document.documentElement.className,
    }))),
  };
  const frames = () =>
    page.evaluate(async () => {
      await document.fonts.ready;
      for (let n = 0; n < 6; n++) await new Promise(requestAnimationFrame);
    });
  const older = page.getByRole("button", { name: "加载更早的消息", exact: true });
  for (let n = 0; n < 6; n++) {
    await older.focus();
    await page.keyboard.press("Enter");
    await page.locator(`[data-side-item-id="answer-${n}"]`).waitFor({ state: "attached" });
    await frames();
  }
  const disclosure = () => page.locator('[data-turn-id="old-5"] .turn-progress-summary');
  await disclosure().click();
  assert.equal(await disclosure().getAttribute("aria-expanded"), "true");
  const turn = () => page.locator('[data-turn-id="old-5"]');
  const reasoning = () => turn().locator(".reasoning-summary");
  const activity = () =>
    turn()
      .locator('.areal-activity-group[data-presentation="collapsible"] .areal-disclosure-trigger')
      .first();
  const tool = () =>
    turn().locator('[data-side-item-id^="command-"] button[aria-expanded]').first();
  await reasoning().click();
  await activity().click();
  await tool().click();
  const checkDisclosures = async () => {
    for (const control of [disclosure(), reasoning(), activity(), tool()])
      assert.equal(await control.getAttribute("aria-expanded"), "true");
  };
  await checkDisclosures();
  await page.locator(".messages").hover();
  await page.mouse.wheel(0, 400);
  await frames();
  const anchor = await page.locator(".messages").evaluate((reader) => {
    const top = reader.getBoundingClientRect().top;
    const node = [
      ...reader.querySelectorAll('[data-side-item-id="answer-5"] .conversation-markdown p'),
    ].find(
      (p) =>
        p.getBoundingClientRect().bottom > top &&
        p.getBoundingClientRect().top < top + reader.clientHeight,
    );
    if (!node) throw Error("Expected old-page paragraph is not visible");
    return {
      index: [...node.parentElement.children].indexOf(node),
      text: node.textContent,
      offset: node.getBoundingClientRect().top - top,
    };
  });
  report.anchor = anchor;
  report.savedBeforeLeave = await page.evaluate(() =>
    sessionStorage.getItem("areal-gui:reading-views:v1"),
  );
  assert.equal(JSON.parse(report.savedBeforeLeave).views[0].position.anchor.itemId, "answer-5");
  const anchorNode = () =>
    page
      .locator('[data-side-item-id="answer-5"] .conversation-markdown')
      .locator(":scope > *")
      .nth(anchor.index);
  const checkAnchor = async (label) => {
    await anchorNode().waitFor();
    await page.waitForFunction(({ index, offset }) => {
      const reader = document.querySelector(".messages");
      const block = reader?.querySelector('[data-side-item-id="answer-5"] .conversation-markdown')
        ?.children[index];
      return (
        block &&
        Math.abs(block.getBoundingClientRect().top - reader.getBoundingClientRect().top - offset) <=
          2
      );
    }, anchor);
    await frames();
    const result = await anchorNode().evaluate((node) => ({
      text: node.textContent,
      offset:
        node.getBoundingClientRect().top - node.closest(".messages").getBoundingClientRect().top,
    }));
    assert.equal(result.text, anchor.text);
    assert.ok(
      Math.abs(result.offset - anchor.offset) <= 2,
      `${label}: ${JSON.stringify({ before: anchor.offset, after: result.offset })}`,
    );
    report.checks.push(label);
  };
  await page.getByRole("button", { name: "Leave conversation", exact: true }).click();
  await page.getByRole("button", { name: "Return to conversation", exact: true }).click();
  await checkAnchor("released old page is restored after returning");
  await page.getByRole("button", { name: "Reobserve", exact: true }).click();
  await checkAnchor("reobservation preserves the old-page anchor");
  await checkDisclosures();
  report.checks.push(
    "manual turn, reasoning, activity and tool disclosures survive old page reload",
  );
  for (let n = 0; n < 10; n++)
    await page.getByRole("button", { name: "Append output", exact: true }).click();
  await checkAnchor("ten live updates do not move the reader");
  await page.getByRole("button", { name: "Toggle width", exact: true }).click();
  await checkAnchor("width reflow preserves the paragraph offset");
  await page.getByRole("button", { name: "Toggle theme", exact: true }).click();
  await checkAnchor("dark theme preserves the paragraph offset");
  await page.screenshot({ path: join(evidence, "dark-reading.png") });
  await page.getByRole("button", { name: "Toggle theme", exact: true }).click();
  await page.screenshot({ path: join(evidence, "light-reading.png") });
  await page.getByRole("button", { name: "Reobserve", exact: true }).click();
  await checkAnchor("old page is present before retry scenario");
  await page.evaluate(() =>
    fetch("/__reading/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "failNext" }),
    }),
  );
  await page.getByRole("button", { name: "Leave conversation", exact: true }).click();
  await page.getByRole("button", { name: "Return to conversation", exact: true }).click();
  await page.locator('[data-reading-blocked="limited"]').waitFor();
  await page.locator("[data-reading-blocked] button").click();
  await checkAnchor("mouse retry recovers a temporarily unavailable old page");
  await page.getByRole("button", { name: "Reobserve", exact: true }).click();
  await checkAnchor("old page is present before keyboard retry");
  await page.evaluate(() =>
    fetch("/__reading/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "failNext" }),
    }),
  );
  await page.getByRole("button", { name: "Leave conversation", exact: true }).click();
  await page.getByRole("button", { name: "Return to conversation", exact: true }).click();
  await page.locator('[data-reading-blocked="limited"] button').focus();
  await page.keyboard.press("Space");
  await checkAnchor("keyboard retry recovers a temporarily unavailable old page");
  await page.reload();
  await checkAnchor("renderer reload restores its persisted old-page anchor");
  await checkDisclosures();
  report.checks.push("manual nested disclosures survive renderer reload");
  await page.getByRole("button", { name: "Reobserve", exact: true }).click();
  await checkAnchor("old page is present before cancellation scenario");
  await page.getByRole("button", { name: "Delay pages", exact: true }).click();
  await page.getByRole("button", { name: "Leave conversation", exact: true }).click();
  await page.getByRole("button", { name: "Return to conversation", exact: true }).click();
  await page.waitForFunction(
    async () => (await (await fetch("/__reading/state")).json()).pending > 0,
  );
  await page.locator(".messages").hover();
  await page.mouse.wheel(0, -200);
  await frames();
  const cancelledTop = await page.locator(".messages").evaluate((node) => node.scrollTop);
  await page.waitForFunction(
    async () => (await (await fetch("/__reading/state")).json()).pending === 0,
  );
  await frames();
  assert.ok(
    Math.abs((await page.locator(".messages").evaluate((node) => node.scrollTop)) - cancelledTop) <=
      2,
    "late restore must not override user scroll",
  );
  report.checks.push("user scroll cancels delayed restoration");
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  await page?.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await fixture.close();
  const finalHashes = await hashes();
  report.changedSources = Object.keys(sourceHashes).filter(
    (path) => sourceHashes[path] !== finalHashes[path],
  );
  if (report.changedSources.length) report.passed = false;
  await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
