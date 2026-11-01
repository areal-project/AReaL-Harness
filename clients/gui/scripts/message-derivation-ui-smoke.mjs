import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";
import { makeTempDir } from "./support/temp.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");
const baseline = process.argv.includes("--baseline");
const evidence = await makeTempDir("areal-message-derivation-");
const sources = [
  "renderer/src/Messages.tsx",
  "renderer/src/ForkHistory.tsx",
  "renderer/src/conversationPresentation.ts",
  "renderer/test-fixtures/message-derivation.tsx",
  "scripts/message-derivation-ui-smoke.mjs",
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sources.map(async (path) => [
      path,
      createHash("sha256")
        .update(await readFile(join(gui, path)))
        .digest("hex"),
    ]),
  ),
);
const workbench = JSON.parse(await readFile(join(gui, "packages/workbench/package.json"), "utf8"));
const vite = await createServer({
  root: join(gui, "renderer"),
  configFile: join(gui, "renderer/vite.config.ts"),
  mode: "design-system",
  optimizeDeps: {
    include: Object.keys(workbench.exports).map((path) => `@areal/workbench${path.slice(1)}`),
  },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "message-derivation-measurement",
      enforce: "pre",
      transform(source, id) {
        if (id.endsWith("/src/Messages.tsx")) {
          assert.ok(source.includes("  const { t } = useI18n();"));
          return source.replace(
            "  const { t } = useI18n();",
            "  const { t } = useI18n(); window.messageCounts.renders++;",
          );
        }
        if (!id.endsWith("/src/conversationPresentation.ts")) return;
        const start =
          "export function executionSegments(items: Data[], turnStatus: string): Data[] {";
        const end = "  return result;\n}\nexport function progressGroups(";
        assert.ok(source.includes(start) && source.includes(end));
        return source
          .replace(
            start,
            `${start} const began = performance.now(); window.messageCounts.calls++; window.messageCounts.items += items.length; try {`,
          )
          .replace(
            end,
            "  return result; } finally { window.messageCounts.cpuMs += performance.now() - began; }\n}\nexport function progressGroups(",
          );
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url.startsWith("/__message-derivation.html")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__message-derivation.html",
              '<!doctype html><html><body style="margin:0"><div id="root"></div><script>window.messageCounts={calls:0,items:0,cpuMs:0,renders:0};window.messageRenderMetrics={commits:0,actualDurationMs:0};window.messageLongTasks=[];new PerformanceObserver(list=>window.messageLongTasks.push(...list.getEntries().map(e=>({startTime:e.startTime,duration:e.duration})))).observe({type:"longtask",buffered:true});</script><script type="module" src="/test-fixtures/message-derivation.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
let browser;
const report = {
  baseline,
  passed: false,
  boundary:
    "real Messages and CoreTaskModel in development React Chrome fixture; no Core, Electron, provider, or package; Profiler includes the Messages subtree",
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: gui, encoding: "utf8" }).trim(),
  sourceHashes,
  local: null,
  streaming: null,
  errors: [],
  checks: [],
  design: {
    interaction: "I-READ",
    rules: ["READ-CONTINUITY-01", "NAV-CONTEXT-01"],
    viewport: { width: 1280, height: 900 },
    theme: "light",
  },
};
try {
  await vite.listen();
  browser = await chromium.launch({
    executablePath:
      process.env.AREAL_CHROMIUM_BIN ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  report.browser = browser.version();
  report.workload = {
    completedTurns: 100,
    activeTurns: 1,
    itemsPerTurn: 6,
    unrelatedUpdates: 12,
    outputDeltas: 20,
  };
  const page = await browser.newPage({ viewport: report.design.viewport });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__message-derivation.html`);
  await page.locator('[data-side-item-id="answer-100"] .conversation-markdown').waitFor();
  const layoutStable = () =>
    page.evaluate(async () => {
      await document.fonts.ready;
      let previous = "";
      let stable = 0;
      for (let frame = 0; frame < 180; frame++) {
        await new Promise(requestAnimationFrame);
        const reader = document.querySelector(".messages");
        const geometry = JSON.stringify([
          reader.scrollTop,
          reader.scrollHeight,
          reader.clientHeight,
          ...[...reader.querySelectorAll('[data-turn-id="turn-50"] .conversation-markdown p')].map(
            (node) => node.getBoundingClientRect().top,
          ),
        ]);
        stable = geometry === previous ? stable + 1 : 0;
        previous = geometry;
        if (
          stable >= 6 &&
          !document
            .getAnimations()
            .some(
              (animation) =>
                animation.playState === "running" &&
                animation.effect?.getTiming().iterations !== Infinity,
            )
        )
          return;
      }
      throw new Error("Messages layout did not reach six stable animation frames");
    });
  const counts = async () => {
    const client = await page.evaluate(() => ({
      ...window.messageCounts,
      ...window.messageRenderMetrics,
      longTasks: window.messageLongTasks.length,
      longTaskMs: window.messageLongTasks.reduce((sum, task) => sum + task.duration, 0),
    }));
    const { metrics } = await cdp.send("Performance.getMetrics");
    return {
      ...client,
      ...Object.fromEntries(
        metrics
          .filter((item) =>
            ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].includes(
              item.name,
            ),
          )
          .map((item) => [`${item.name}Ms`, item.value * 1000]),
      ),
    };
  };
  const difference = (after, before) =>
    Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
  await layoutStable();
  const beforeLocal = await counts();
  for (let index = 1; index <= 12; index++) {
    await page.getByRole("button", { name: /^Local chrome update/ }).click();
    await page.getByTestId("fixture-local").getByText(String(index), { exact: true }).waitFor();
  }
  await layoutStable();
  report.local = difference(await counts(), beforeLocal);
  assert.ok(report.local.renders >= 12);
  if (baseline)
    assert.ok(report.local.calls >= 12 * 101, "baseline records all current Turn derivations");
  const turn = page.locator('[data-turn-id="turn-50"]');
  const disclosure = turn.locator("button[aria-expanded]").first();
  await disclosure.scrollIntoViewIfNeeded();
  await disclosure.focus();
  await page.keyboard.press("Enter");
  assert.equal(await disclosure.getAttribute("aria-expanded"), "true");
  await layoutStable();
  assert.ok(
    (await turn.innerText()).includes("已探索，已运行命令"),
    "production activity grouping combines the two reads and command",
  );
  await turn
    .locator('[data-side-item-id="answer-50"] .conversation-markdown p')
    .first()
    .scrollIntoViewIfNeeded();
  await page.locator(".messages").hover();
  await page.mouse.wheel(0, -120);
  await layoutStable();
  const anchor = await page.locator(".messages").evaluate((reader) => {
    const box = reader.getBoundingClientRect();
    const node = [...reader.querySelectorAll("[data-side-item-id] .conversation-markdown p")].find(
      (node) => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > box.top && rect.top < box.bottom;
      },
    );
    if (!node) throw Error("No visible semantic paragraph");
    const item = node.closest("[data-side-item-id]");
    return {
      item: item.getAttribute("data-side-item-id"),
      paragraph: [...item.querySelectorAll(".conversation-markdown p")].indexOf(node),
      offset: node.getBoundingClientRect().top - box.top,
      text: node.textContent,
    };
  });
  report.anchorBefore = anchor;
  const anchorOffset = () =>
    page
      .locator(`[data-side-item-id="${anchor.item}"] .conversation-markdown p`)
      .nth(anchor.paragraph)
      .evaluate(
        (node) =>
          node.getBoundingClientRect().top - node.closest(".messages").getBoundingClientRect().top,
      );
  const beforeStream = await counts();
  for (let index = 1; index <= 20; index++) {
    await page.evaluate((index) => window.messageFixture.delta(index), index);
    await page
      .locator('[data-side-item-id="answer-100"]')
      .getByText(new RegExp(`output-${index}$`))
      .waitFor({ state: "attached" });
  }
  report.streaming = difference(await counts(), beforeStream);
  if (baseline)
    assert.ok(
      report.streaming.calls >= 20 * 101,
      "baseline records all current Turn derivations on output",
    );
  await layoutStable();
  assert.equal(await disclosure.getAttribute("aria-expanded"), "true");
  report.anchorAfter = await anchorOffset();
  assert.equal(
    await page
      .locator(`[data-side-item-id="${anchor.item}"] .conversation-markdown p`)
      .nth(anchor.paragraph)
      .textContent(),
    anchor.text,
    "the semantic reading anchor retains its original paragraph text",
  );
  assert.ok(
    Math.abs(report.anchorAfter - anchor.offset) <= 1,
    `background output preserves the visible semantic anchor: ${JSON.stringify({ anchor, after: report.anchorAfter })}`,
  );
  report.checks.push("manual disclosure and reading anchor survive 20 live deltas");
  await page.evaluate(() => window.messageFixture.complete());
  await page.waitForFunction(() =>
    document.querySelector('[data-turn-id="turn-100"]')?.textContent.includes("Worked for 4s"),
  );
  report.checks.push("terminal status invalidates the active Turn");
  await page.evaluate(() => window.messageFixture.gap(true));
  await page.locator('[data-history-page-id="evicted-page"]').waitFor();
  await page.evaluate(() => window.messageFixture.gap(false));
  await page.locator('[data-history-page-id="evicted-page"]').waitFor({ state: "detached" });
  report.checks.push("history gap insertion and removal update immediately");
  await page.evaluate(() => window.messageFixture.replaceOwner());
  await page.getByText("REPLACEMENT_OWNER_RESULT", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-turn-id="turn-50"]').count(), 0);
  report.checks.push(
    "a new owner with the same Thread/Turn IDs and new authoritative data replaces old content",
  );
  assert.ok(
    (await page.evaluate(() => window.messageFixture.calls)).every(
      (call) => call.name === "history" || call.name === "feedback",
    ),
  );
  assert.deepEqual(report.errors, []);
  await page.screenshot({ path: join(evidence, "messages.png") });
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  const closed = await Promise.allSettled([browser?.close(), vite.close()]);
  report.cleanup = Object.fromEntries(
    closed.map((result, index) => [
      index === 0 ? "browser" : "vite",
      result.status === "fulfilled"
        ? { passed: true }
        : { passed: false, message: String(result.reason) },
    ]),
  );
  if (closed.some((result) => result.status === "rejected")) report.passed = false;
  await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidence }));
}
assert.equal(report.passed, true, "measurement cleanup failed; see report.json");
