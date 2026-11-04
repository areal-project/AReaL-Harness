import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";
import { makeTempDir } from "./support/temp.mjs";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const root = fileURLToPath(new URL("../renderer/", import.meta.url));
const evidence = await makeTempDir("areal-send-continuity-");
const vite = await createServer({
  root,
  configFile: fileURLToPath(new URL("../renderer/vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
  optimizeDeps: {
    include: [
      "catalog",
      "conversation",
      "library-media",
      "management",
      "management-context",
      "mcp-page",
      "provider",
      "resource",
      "shared",
      "snapshots",
      "transport",
      "workspace",
    ].map((name) => `@areal/workbench/desktop-contract/${name}`),
  },
});
let browser;
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const report = {
  passed: false,
  evidence,
  scenarios: [],
  errors: [],
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim(),
  dirty: execFileSync("git", ["status", "--short"], { cwd: repository, encoding: "utf8" }).trim(),
};
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.AREAL_GUI_TEST_BROWSER
      ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER }
      : { channel: "chrome" }),
  });
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  report.viewport = { width: 1100, height: 800 };
  page.on("pageerror", (error) => report.errors.push(error.message));
  const rootLocator = page.locator("[data-send-continuity]");
  const frames = () =>
    page.evaluate(async () => {
      for (let n = 0; n < 6; n++) await new Promise(requestAnimationFrame);
    });
  const samples = () =>
    rootLocator.evaluate((root) => JSON.parse(root.getAttribute("data-send-frames") ?? "[]"));
  const earlyFailures = [];
  for (const lines of ["single", "multi"]) {
    for (const method of ["click", "enter"]) {
      await page.goto(
        `http://127.0.0.1:${vite.httpServer.address().port}/design-system.html?send-continuity`,
      );
      for (let index = 1; index <= 2; index++) {
        const input = page.getByTestId("chat-input");
        await input.fill(`QUESTION ${index}`);
        if (lines === "multi") {
          await input.press("Shift+Enter");
          await page.keyboard.type("SECOND LINE");
          await input.press("Shift+Enter");
          await page.keyboard.type("THIRD LINE");
        }
        await frames();
        const prior = await samples();
        const before = prior.at(-1);
        const start = prior.length;
        if (method === "click") await page.getByTestId("chat-send-button").click();
        else await input.press("Enter");
        await page.getByTestId("pending-message").waitFor();
        await frames();
        await page.getByRole("button", { name: "Release receipt", exact: true }).click();
        await frames();
        await page.getByRole("button", { name: "Deliver snapshot", exact: true }).click();
        await page.locator(`[data-side-item-id="user-${index}"]`).waitFor();
        await frames();
        const observed = (await samples()).slice(start);
        const markers = await rootLocator.evaluate((root) =>
          JSON.parse(root.getAttribute("data-send-markers") ?? "[]"),
        );
        report.scenarios.push({
          kind: "early-send",
          lines,
          method,
          index,
          before,
          markers: markers.filter((marker) => marker.time >= before.time),
          frames: observed,
        });
        const pendingFrames = observed.filter((sample) => sample.pendingBubbleHeight !== undefined);
        if (pendingFrames.some((sample) => !sample.pendingText?.includes(`QUESTION ${index}`)))
          earlyFailures.push(`${lines}/${method}/${index}: pending text is unavailable`);
        const bubbles = observed
          .map((sample) => sample.pendingBubbleHeight)
          .filter(Number.isFinite);
        if (bubbles.length < 2)
          earlyFailures.push(`${lines}/${method}/${index}: insufficient pending frames`);
        else if (Math.max(...bubbles) - Math.min(...bubbles) > 1)
          earlyFailures.push(
            `${lines}/${method}/${index}: pending bubble height changed ${Math.min(...bubbles)} to ${Math.max(...bubbles)}`,
          );
        const firstPending = observed.findIndex((sample) => sample.pendingBubbleY !== undefined);
        const bubblePositions = observed
          .slice(Math.max(firstPending, 0))
          .map((sample) => sample.pendingBubbleY ?? sample.userBubbleY)
          .filter(Number.isFinite);
        if (
          bubblePositions.length < 2 ||
          Math.max(...bubblePositions) - Math.min(...bubblePositions) > 1
        )
          earlyFailures.push(
            `${lines}/${method}/${index}: user bubble moved ${JSON.stringify(bubblePositions)}`,
          );
        const heights = observed.map((sample) => sample.composerHeight).filter(Number.isFinite);
        if (heights.some((height, i) => i > 0 && height > heights[i - 1] + 1))
          earlyFailures.push(`${lines}/${method}/${index}: composer grew after sending`);
        await page.getByRole("button", { name: "Complete turn", exact: true }).click();
        await frames();
      }
    }
  }
  report.earlyFailures = earlyFailures;
  assert.deepEqual(earlyFailures, [], "early send geometry should remain stable");
  for (const order of ["receipt-first", "snapshot-first"]) {
    await page.goto(
      `http://127.0.0.1:${vite.httpServer.address().port}/design-system.html?send-continuity`,
    );
    for (let index = 1; index <= 2; index++) {
      const text = index === 1 ? "FIRST QUESTION" : "SECOND QUESTION";
      await page.getByTestId("chat-input").fill(text);
      const clickStart = (await samples()).length;
      await page.getByTestId("chat-send-button").click();
      await page.getByTestId("pending-message").getByText(text).waitFor();
      await frames();
      const start = (await samples()).length;
      const before = (await samples()).at(-1);
      const first = order === "receipt-first" ? "Release receipt" : "Deliver snapshot";
      const second = order === "receipt-first" ? "Deliver snapshot" : "Release receipt";
      await page.getByRole("button", { name: first, exact: true }).click();
      await frames();
      if (order === "receipt-first")
        assert.equal(await page.getByTestId("pending-message").isVisible(), true);
      else
        assert.equal(await page.locator(`[data-side-item-id="user-${index}"]`).isVisible(), true);
      await page.getByRole("button", { name: second, exact: true }).click();
      await page.locator(`[data-side-item-id="user-${index}"]`).waitFor();
      await frames();
      const observed = (await samples()).slice(start);
      const sinceClick = (await samples()).slice(clickStart);
      const firstVisible = sinceClick.findIndex(
        (sample) => sample.pendingVisible || sample.userVisible,
      );
      const handoff = sinceClick.slice(firstVisible);
      report.scenarios.push({ order, index, before, frames: handoff });
      assert.ok(firstVisible >= 0, "new user message never becomes visible");
      assert.ok(
        handoff.every((sample) => sample.pendingVisible || sample.userVisible),
        "new user message disappears during handoff",
      );
      const positions = [
        before.pendingY,
        ...observed.map((sample) => sample.pendingY ?? sample.userY),
      ].filter(Number.isFinite);
      assert.ok(positions.length > 2);
      assert.ok(
        Math.max(...positions) - Math.min(...positions) <= 1,
        `user message moved during handoff: ${JSON.stringify(positions)}`,
      );
      if (index === 2) {
        assert.ok(observed.length > 2);
        assert.ok(
          observed.every(
            (sample) => sample.pendingVisible || sample.userVisible || !sample.oldVisible,
          ),
          "old answer flashes without the new user message",
        );
      }
      await page.screenshot({ path: `${evidence}/${order}-${index}.png` });
      await page.getByRole("button", { name: "Complete turn", exact: true }).click();
      await frames();
    }
  }
  await page.goto(
    `http://127.0.0.1:${vite.httpServer.address().port}/design-system.html?send-continuity`,
  );
  await page.getByTestId("chat-input").fill("FIRST QUESTION");
  await page.getByTestId("chat-send-button").click();
  await page.getByTestId("pending-message").waitFor();
  await page.getByRole("button", { name: "Release receipt", exact: true }).click();
  await page.getByRole("button", { name: "Deliver snapshot", exact: true }).click();
  await page.getByRole("button", { name: "Complete turn", exact: true }).click();
  await page.getByTestId("chat-input").fill("IMAGE QUESTION");
  await page.locator('input[type="file"]').setInputFiles({
    name: "image.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page.getByTestId("chat-send-button").click();
  await page.getByTestId("pending-message").locator("img").waitFor();
  await frames();
  const geometry = async (selector) =>
    page.locator(selector).evaluate((element) => ({
      top: element.getBoundingClientRect().top,
      height: element.getBoundingClientRect().height,
    }));
  const pendingImage = await geometry('[data-testid="pending-message"]');
  await page.getByRole("button", { name: "Release receipt", exact: true }).click();
  await page.getByRole("button", { name: "Deliver snapshot", exact: true }).click();
  await page.locator('[data-side-item-id="user-2"] [data-message-attachment="image"]').waitFor();
  await frames();
  const loadingImage = await geometry('[data-side-item-id="user-2"]');
  await page.screenshot({ path: `${evidence}/image-loading.png` });
  await page.getByRole("button", { name: "Release media", exact: true }).click();
  await page.locator('[data-side-item-id="user-2"] img').waitFor();
  await frames();
  const loadedImage = await geometry('[data-side-item-id="user-2"]');
  await page.screenshot({ path: `${evidence}/image-loaded.png` });
  report.image = { pendingImage, loadingImage, loadedImage };
  assert.ok(
    Math.abs(pendingImage.top - loadingImage.top) <= 1,
    "image placeholder moves the user message",
  );
  assert.ok(
    Math.abs(loadingImage.top - loadedImage.top) <= 1,
    "loaded image moves the user message",
  );
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser?.close();
  await vite.close();
  await writeFile(`${evidence}/report.json`, JSON.stringify(report, null, 2));
  console.log(`Send continuity evidence: ${evidence}; ${report.passed ? "PASS" : "FAIL"}`);
}
