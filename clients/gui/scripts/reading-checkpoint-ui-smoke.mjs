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
const evidence = await makeTempDir("areal-reading-checkpoint-");
console.log(JSON.stringify({ evidence, baseline }));
const sources = [
  "renderer/src/readingViews.ts",
  "renderer/src/Messages.tsx",
  "renderer/src/ForkHistory.tsx",
  "renderer/test-fixtures/reading-checkpoint.tsx",
  "scripts/reading-checkpoint-ui-smoke.mjs",
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
await writeFile(join(evidence, "readingViews.ts"), await readFile(join(gui, sources[0])));
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
      name: "reading-checkpoint-fixture",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url.startsWith("/__reading-checkpoint.html")) return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              "/__reading-checkpoint.html",
              '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="/test-fixtures/reading-checkpoint.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});

function sampledCheckpointCpu(profile) {
  const parents = new Map();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parents.set(child, node.id);
  const wrappers = new Set(
    profile.nodes
      .filter((node) => node.callFrame.functionName === "readingCheckpointStringify")
      .map((node) => node.id),
  );
  let microseconds = 0,
    samples = 0;
  for (const [index, sampled] of (profile.samples ?? []).entries()) {
    let id = sampled;
    while (id !== undefined && !wrappers.has(id)) id = parents.get(id);
    if (id === undefined) continue;
    microseconds += profile.timeDeltas?.[index] ?? 0;
    samples++;
  }
  return { sampledCheckpointCpuMs: microseconds / 1000, checkpointSamples: samples };
}

let browser;
const errors = [];
const report = {
  passed: false,
  baseline,
  evidence,
  sourceHashes,
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: gui, encoding: "utf8" }).trim(),
  boundary:
    "real Chrome and production Messages/saveReadingViews; synthetic persisted checkpoints and React stream inputs; no Core, Electron, or package",
  measurement:
    "JSON wrappers count checkpoint envelope/entry serialization and time synchronous native stringify; separate Chrome CPU profiles sample that wrapper at 100 microseconds; no whole-application latency claim",
  conditions: {
    viewport: { width: 1100, height: 800 },
    theme: "light",
    fontSize: 14,
    scrollInputs: 96,
    streamUpdates: 24,
  },
  cases: [],
  errors,
};
try {
  await vite.listen();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  report.browserVersion = browser.version();
  for (const contexts of [1, 32]) {
    const context = await browser.newContext({
      viewport: report.conditions.viewport,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const metrics = (window.readingMetrics = {
        active: false,
        jsonCalls: 0,
        rootCalls: 0,
        entryCalls: 0,
        serializedCharacters: 0,
        stringifySyncMs: 0,
        storageWrites: 0,
        scrollEvents: 0,
        resizeCallbacks: 0,
      });
      const stringify = JSON.stringify;
      JSON.stringify = function readingCheckpointStringify(value, ...args) {
        const root = value?.version === 1 && Array.isArray(value.views);
        const entry = typeof value?.owner === "string" && value.position?.kind;
        if (!metrics.active || (!root && !entry)) return stringify.call(JSON, value, ...args);
        const started = performance.now();
        const result = stringify.call(JSON, value, ...args);
        metrics.stringifySyncMs += performance.now() - started;
        metrics.jsonCalls++;
        metrics.rootCalls += Number(root);
        metrics.entryCalls += Number(!!entry);
        metrics.serializedCharacters += result.length;
        return result;
      };
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (metrics.active && key === "areal-gui:reading-views:v1") metrics.storageWrites++;
        return setItem.call(this, key, value);
      };
      document.addEventListener(
        "scroll",
        (event) => {
          if (
            metrics.active &&
            event.target instanceof Element &&
            event.target.matches(".messages")
          )
            metrics.scrollEvents++;
        },
        true,
      );
      const NativeResizeObserver = ResizeObserver;
      window.ResizeObserver = class extends NativeResizeObserver {
        constructor(callback) {
          super((entries, observer) => {
            if (
              metrics.active &&
              entries.some(({ target }) => target.matches(".messages, .message-column"))
            )
              metrics.resizeCallbacks++;
            callback(entries, observer);
          });
        }
      };
    });
    await page.goto(
      `http://127.0.0.1:${vite.httpServer.address().port}/__reading-checkpoint.html?contexts=${contexts}`,
    );
    const messages = page.locator(".messages");
    await messages.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await messages.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    await messages.hover();
    await page.mouse.wheel(0, -300);
    await page.waitForFunction(() => {
      const raw = sessionStorage.getItem("areal-gui:reading-views:v1");
      return raw && JSON.parse(raw).views[0].position.kind === "reading";
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
    const measure = async (phase, operation) => {
      await page.evaluate(() => {
        for (const key of Object.keys(window.readingMetrics))
          window.readingMetrics[key] = key === "active" ? true : 0;
      });
      await cdp.send("Profiler.start");
      await operation();
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      const metrics = await page.evaluate(() => {
        window.readingMetrics.active = false;
        return { ...window.readingMetrics };
      });
      const { profile } = await cdp.send("Profiler.stop");
      await writeFile(join(evidence, `${contexts}-${phase}.cpuprofile`), JSON.stringify(profile));
      return { phase, ...metrics, ...sampledCheckpointCpu(profile) };
    };
    const scroll = await measure("scroll", async () => {
      await messages.hover();
      for (let index = 0; index < report.conditions.scrollInputs; index++) {
        const previous = await messages.evaluate((element) => element.scrollTop);
        await page.mouse.wheel(0, index % 2 ? -30 : 30);
        await page.waitForFunction(
          (top) => document.querySelector(".messages").scrollTop !== top,
          previous,
        );
      }
    });
    assert.ok(scroll.jsonCalls > 0 && scroll.scrollEvents >= report.conditions.scrollInputs);
    assert.ok(scroll.storageWrites > 0, "scrolling must synchronously update its checkpoint");
    const beforeStream = await page.evaluate(() =>
      sessionStorage.getItem("areal-gui:reading-views:v1"),
    );
    const stream = await measure("stream", async () => {
      for (let output = 1; output <= report.conditions.streamUpdates; output++) {
        await page.getByRole("button", { name: "Append output", exact: true }).click();
        await page.waitForFunction(
          (value) =>
            document.querySelector('[data-testid="reading-fixture"]').dataset.output ===
            String(value),
          output,
        );
        await page.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
        );
      }
    });
    const raw = await page.evaluate(() => sessionStorage.getItem("areal-gui:reading-views:v1"));
    const saved = JSON.parse(raw);
    assert.equal(saved.views.length, contexts);
    assert.equal(new Set(saved.views.map((entry) => entry.owner)).size, contexts);
    assert.ok(raw.length <= 65536);
    assert.equal(saved.views[0].position.kind, "reading");
    assert.equal(raw, beforeStream, "output appended below the reader must not replace its anchor");
    assert.ok(stream.jsonCalls > 0 && stream.resizeCallbacks > 0);
    assert.equal(stream.storageWrites, 0, "unchanged semantic anchors do not write storage");
    await page.screenshot({ path: join(evidence, `${contexts}-reading.png`) });
    await page.reload();
    await page.locator(".messages").waitFor();
    const anchor = saved.views[0].position.anchor;
    try {
      await page.waitForFunction((anchor) => {
        const container = document.querySelector(".messages");
        const item = [...container.querySelectorAll("[data-side-item-id]")].find(
          (element) => element.dataset.sideItemId === anchor.itemId,
        );
        const block =
          anchor.blockIndex === null
            ? item
            : item?.querySelector(".conversation-markdown")?.children[anchor.blockIndex];
        return (
          block &&
          Math.abs(
            block.getBoundingClientRect().top -
              container.getBoundingClientRect().top -
              anchor.offset,
          ) <= 1
        );
      }, anchor);
    } catch (error) {
      report.reloadFailure = await page.evaluate((anchor) => {
        const container = document.querySelector(".messages");
        const item = [...(container?.querySelectorAll("[data-side-item-id]") ?? [])].find(
          (element) => element.dataset.sideItemId === anchor.itemId,
        );
        const block =
          anchor.blockIndex === null
            ? item
            : item?.querySelector(".conversation-markdown")?.children[anchor.blockIndex];
        const box = (element) =>
          element
            ? {
                top: element.getBoundingClientRect().top,
                height: element.getBoundingClientRect().height,
                display: getComputedStyle(element).display,
              }
            : null;
        return {
          anchor,
          container: container && {
            ...box(container),
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
          },
          item: box(item),
          block: box(block),
          blocked: document.querySelector("[data-reading-blocked]")?.outerHTML,
          saved: sessionStorage.getItem("areal-gui:reading-views:v1"),
        };
      }, anchor);
      await page.screenshot({ path: join(evidence, `${contexts}-reload-failure.png`) });
      throw error;
    }
    report.cases.push({
      contexts,
      scroll,
      stream,
      checkpoint: saved.views[0],
      checkpointCharacters: raw.length,
      reloadAnchorRestored: true,
    });
    if (!baseline) {
      for (const phase of [scroll, stream]) {
        assert.equal(phase.rootCalls, 0, "checkpoint saves must not serialize growing prefixes");
        assert.equal(phase.entryCalls, phase.jsonCalls);
        assert.equal(
          phase.entryCalls % contexts,
          0,
          "each save serializes each retained entry once",
        );
      }
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  const closed = await Promise.allSettled([browser?.close(), vite.close()]);
  report.cleanupErrors = closed.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ component: index === 0 ? "browser" : "vite", message: String(result.reason) }]
      : [],
  );
  report.changedSources = [];
  for (const [path, digest] of Object.entries(sourceHashes)) {
    try {
      const actual = createHash("sha256")
        .update(await readFile(join(gui, path)))
        .digest("hex");
      if (actual !== digest) report.changedSources.push(path);
    } catch {
      report.changedSources.push(path);
    }
  }
  if (report.cleanupErrors.length || report.changedSources.length) report.passed = false;
  await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, evidence, cases: report.cases }));
  assert.deepEqual(report.cleanupErrors, [], "measurement cleanup failed; see report.json");
  assert.deepEqual(report.changedSources, [], "measurement source changed; see report.json");
}
