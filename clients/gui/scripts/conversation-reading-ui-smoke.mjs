import { until } from "./support/desktop-fixture.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadingFixture } from "./conversation-reading-fixture.mjs";
import { makeTempDir } from "./support/temp.mjs";
const require = createRequire(new URL("../app/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const evidence = await makeTempDir("areal-reading-continuity-");
const fixture = await createReadingFixture();
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const dirtyFiles = execFileSync("git", ["ls-files", "-m", "-o", "--exclude-standard"], {
  encoding: "utf8",
  cwd: repository,
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
          .update(await readFile(join(repository, path)))
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
  const messages = page.locator(".messages");
  const historyReady = () =>
    page.waitForFunction(() => {
      const fixture = document.querySelector("[data-fixture-history]");
      const history = JSON.parse(fixture?.getAttribute("data-fixture-history") ?? "null");
      return (
        history?.supported &&
        fixture?.getAttribute("data-fixture-history-ready") === history.viewGeneration &&
        !history.loadingLatest &&
        history.latestTurnComplete !== false &&
        !history.loadingOlder
      );
    });
  const reobserve = async () => {
    const main = page.locator("[data-fixture-history]");
    const previous = JSON.parse(await main.getAttribute("data-fixture-history")).viewGeneration;
    await page.getByRole("button", { name: "Reobserve", exact: true }).click();
    await page.waitForFunction((previous) => {
      const history = JSON.parse(
        document.querySelector("[data-fixture-history]")?.getAttribute("data-fixture-history") ??
          "null",
      );
      return history?.viewGeneration && history.viewGeneration !== previous;
    }, previous);
  };
  assert.equal(await page.getByRole("button", { name: "加载更早的消息", exact: true }).count(), 0);
  await historyReady();
  await page.waitForFunction(() => {
    const reader = document.querySelector(".messages");
    const saved = JSON.parse(sessionStorage.getItem("areal-gui:reading-views:v1") ?? "null");
    return (
      reader &&
      reader.scrollHeight - reader.scrollTop - reader.clientHeight <= 1 &&
      saved?.views?.[0]?.position?.kind === "latest"
    );
  });
  report.initialReading = await messages.evaluate((reader) => ({
    top: reader.scrollTop,
    max: reader.scrollHeight - reader.clientHeight,
    saved: sessionStorage.getItem("areal-gui:reading-views:v1"),
  }));
  for (let n = 0; n < 6; n++) {
    await historyReady();
    const previousCalls = fixture.snapshot().calls;
    await messages.evaluate((element) => {
      element.scrollTop = 0;
    });
    await messages.focus();
    await page.waitForFunction(() => {
      const reader = document.querySelector(".messages");
      const saved = JSON.parse(sessionStorage.getItem("areal-gui:reading-views:v1") ?? "null");
      const anchor = saved?.views?.[0]?.position?.anchor;
      const item = [...reader.querySelectorAll("[data-side-item-id]")].find(
        (node) => node.dataset.sideItemId === anchor?.itemId,
      );
      const block =
        anchor?.blockIndex == null
          ? item
          : item?.querySelector(".conversation-markdown")?.children[anchor.blockIndex];
      return (
        document.activeElement === reader &&
        reader.scrollTop === 0 &&
        block &&
        Math.abs(
          block.getBoundingClientRect().top - reader.getBoundingClientRect().top - anchor.offset,
        ) <= 2
      );
    });
    await page.keyboard.press("PageUp");
    await page.locator(`[data-side-item-id="answer-${n}"]`).waitFor({ state: "attached" });
    await page.waitForFunction(
      (previous) =>
        Number(
          document
            .querySelector("[data-fixture-history-calls]")
            ?.getAttribute("data-fixture-history-calls"),
        ) > previous,
      previousCalls,
    );
    await historyReady();
    await frames();
  }
  const disclosure = () =>
    page.locator(
      '[data-turn-id="old-5"] [data-testid="turn-elapsed"] button[aria-expanded], [data-turn-id="old-5"] .turn-progress-summary',
    );
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
  await messages.evaluate(async (reader) => {
    await Promise.all(
      reader
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation.playState === "running" &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime),
        )
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const checkDisclosures = async () => {
    const controls = { disclosure, reasoning, activity, tool };
    const expanded = {};
    for (const [name, control] of Object.entries(controls))
      expanded[name] = await control().getAttribute("aria-expanded");
    assert.deepEqual(expanded, {
      disclosure: "true",
      reasoning: "true",
      activity: "true",
      tool: "true",
    });
  };
  await checkDisclosures();
  await messages.focus();
  const beforeReading = await messages.evaluate((reader) => reader.scrollTop);
  await messages.evaluate((reader) => {
    reader.dataset.fixtureScrollEnd = "pending";
    reader.addEventListener(
      "scrollend",
      () => {
        reader.dataset.fixtureScrollEnd = "settled";
      },
      {
        once: true,
      },
    );
  });
  await messages.press("ArrowDown");
  await page.waitForFunction(
    (previous) => document.querySelector(".messages").scrollTop > previous,
    beforeReading,
  );
  await page.locator('.messages[data-fixture-scroll-end="settled"]').waitFor();
  await messages.evaluate((reader) => {
    const answer = reader.querySelector('[data-side-item-id="answer-5"]');
    reader.scrollTop +=
      answer.getBoundingClientRect().top - reader.getBoundingClientRect().top + 200;
  });
  await page.waitForFunction(() => {
    const reader = document.querySelector(".messages");
    const answer = reader?.querySelector('[data-side-item-id="answer-5"]');
    if (!answer) return false;
    const top = reader.getBoundingClientRect().top;
    const rect = answer.getBoundingClientRect();
    return rect.top < top && rect.bottom > top;
  });
  await frames();
  await page.waitForFunction(() => {
    const saved = JSON.parse(sessionStorage.getItem("areal-gui:reading-views:v1") ?? "null");
    return saved?.views?.[0]?.position?.anchor?.itemId === "answer-5";
  });
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
  const savedAnchor = JSON.parse(report.savedBeforeLeave).views[0].position.anchor;
  assert.equal(savedAnchor.itemId, "answer-5");
  assert.equal(savedAnchor.blockIndex, anchor.index);
  assert.ok(Math.abs(savedAnchor.offset - anchor.offset) <= 2);
  const anchorNode = () =>
    page
      .locator('[data-side-item-id="answer-5"] .conversation-markdown')
      .locator(":scope > div > *")
      .nth(anchor.index);
  const checkAnchor = async (label) => {
    await anchorNode().waitFor();
    await page.waitForFunction(({ index, offset }) => {
      const reader = document.querySelector(".messages");
      const root = reader?.querySelector('[data-side-item-id="answer-5"] .conversation-markdown');
      const container =
        root?.children.length === 1 && root.children[0].tagName === "DIV" ? root.children[0] : root;
      const block = container?.children[index];
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
  await reobserve();
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
  await checkAnchor("old page is present before unavailable history scenario");
  await page.getByRole("button", { name: "Leave conversation", exact: true }).click();
  // 新快照到达时阅读视图已释放。当前快照的缓存可保留，旧快照的正文需要按锚点重取。
  await reobserve();
  await page.evaluate(() =>
    fetch("/__reading/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "failNext" }),
    }),
  );
  const failureTraceStart = await page.evaluate(() => window.readingTrace.length);
  const failuresBefore = fixture.snapshot().failures;
  await page.getByRole("button", { name: "Return to conversation", exact: true }).click();
  await page.waitForFunction(
    (start) =>
      window.readingTrace
        .slice(start)
        .some(
          (entry) =>
            entry.operation === "ensureAnchor" && entry.settled && entry.result === "limited",
        ),
    failureTraceStart,
  );
  assert.equal(
    fixture.snapshot().failures,
    failuresBefore + 1,
    "failure reached original history read",
  );
  await frames();
  assert.equal(await page.getByText("暂时无法恢复阅读位置", { exact: false }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "重试恢复位置", exact: true }).count(), 0);
  assert.equal(await page.locator("[data-reading-blocked]").count(), 0);
  await page.screenshot({ path: join(evidence, "unavailable-history.png") });
  report.checks.push("unavailable history shows no reading restoration error or retry control");
  await page.getByRole("button", { name: "Leave conversation", exact: true }).click();
  await page.getByRole("button", { name: "Return to conversation", exact: true }).click();
  await checkAnchor("return after unavailable history restores the retained anchor");
  await page.reload();
  await checkAnchor("renderer reload restores its persisted old-page anchor");
  await checkDisclosures();
  report.checks.push("manual nested disclosures survive renderer reload");
  await checkAnchor("old page is present before cancellation scenario");
  await page.getByRole("button", { name: "Leave conversation", exact: true }).click();
  await reobserve();
  const holdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/__reading/control") &&
      response.request().postDataJSON().operation === "hold",
  );
  await page.getByRole("button", { name: "Hold pages", exact: true }).click();
  assert.ok((await holdResponse).ok());
  await page.waitForFunction(() => {
    const history = JSON.parse(
      document.querySelector("[data-fixture-history]")?.getAttribute("data-fixture-history") ??
        "null",
    );
    return (
      history &&
      !(history.pageTopology ?? []).some((page) =>
        page.items.some((item) => item.itemId === "answer-5"),
      )
    );
  });
  const restoreTraceStart = await page.evaluate(() => window.readingTrace.length);
  await page.getByRole("button", { name: "Return to conversation", exact: true }).click();
  await until(() => fixture.snapshot().held.length > 0, "history restore request held");
  const ensure = await page.evaluate(
    (start) =>
      window.readingTrace
        .slice(start)
        .find((entry) => entry.operation === "ensureAnchor" && !entry.settled),
    restoreTraceStart,
  );
  assert.ok(ensure, "the original anchor read is pending while Host holds its page");
  report.heldRestore = fixture.snapshot().held;
  await page.locator(".messages").hover();
  const beforeWheel = await messages.evaluate((reader) => {
    reader.dataset.fixtureWheelEnd = "pending";
    reader.addEventListener(
      "wheel",
      (event) => {
        reader.dataset.fixtureWheelDelta = String(event.deltaY);
      },
      { once: true },
    );
    reader.addEventListener(
      "scrollend",
      () => {
        reader.dataset.fixtureWheelEnd = "settled";
      },
      { once: true },
    );
    return reader.scrollTop;
  });
  await page.mouse.wheel(0, -200);
  await page.locator('.messages[data-fixture-wheel-delta="-200"]').waitFor();
  await page.locator('.messages[data-fixture-wheel-end="settled"]').waitFor();
  const retained = await (
    await page.waitForFunction(
      (ensure) =>
        window.readingTrace.find(
          (entry) =>
            entry.operation === "retain" &&
            entry.viewId === ensure.viewId &&
            entry.revision > ensure.revision &&
            entry.settled,
        ),
      ensure,
    )
  ).jsonValue();
  await frames();
  const cancelledAnchor = await messages.evaluate((reader, beforeWheel) => {
    const viewport = reader.getBoundingClientRect();
    for (const item of reader.querySelectorAll("[data-side-item-id]")) {
      const blocks = [...(item.querySelector(".conversation-markdown")?.children ?? [])];
      const index = blocks.findIndex(
        (block) =>
          block.getBoundingClientRect().bottom > viewport.top &&
          block.getBoundingClientRect().top < viewport.bottom,
      );
      const block = blocks[index] ?? item;
      const rect = block.getBoundingClientRect();
      if (rect.bottom > viewport.top && rect.top < viewport.bottom)
        return {
          itemId: item.dataset.sideItemId,
          index,
          text: block.textContent,
          offset: rect.top - viewport.top,
          top: reader.scrollTop,
          beforeWheel,
        };
    }
    throw Error("No visible reading anchor after user scroll");
  }, beforeWheel);
  report.cancelledAnchor = {
    ...cancelledAnchor,
    ensure,
    retained,
  };
  await page.evaluate(() =>
    fetch("/__reading/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "release" }),
    }),
  );
  report.cancelledRestore = await (
    await page.waitForFunction(
      (ensure) =>
        window.readingTrace.find(
          (entry) =>
            entry.operation === "ensureAnchor" &&
            entry.viewId === ensure.viewId &&
            entry.revision === ensure.revision &&
            entry.settled,
        ),
      ensure,
    )
  ).jsonValue();
  assert.equal(report.cancelledRestore.result, "cancelled");
  await historyReady();
  await frames();
  const afterCancellation = await messages.evaluate((reader, anchor) => {
    const item = [...reader.querySelectorAll("[data-side-item-id]")].find(
      (entry) => entry.dataset.sideItemId === anchor.itemId,
    );
    const block =
      anchor.index < 0
        ? item
        : item?.querySelector(".conversation-markdown")?.children[anchor.index];
    return {
      top: reader.scrollTop,
      text: block?.textContent,
      offset: block && block.getBoundingClientRect().top - reader.getBoundingClientRect().top,
    };
  }, cancelledAnchor);
  report.afterCancellation = afterCancellation;
  assert.equal(afterCancellation.text, cancelledAnchor.text);
  assert.ok(
    afterCancellation.offset !== undefined &&
      Math.abs(afterCancellation.offset - cancelledAnchor.offset) <= 2,
    `late restore must not override user scroll: ${JSON.stringify({ before: cancelledAnchor, after: afterCancellation })}`,
  );
  report.checks.push("user scroll cancels delayed restoration");
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  const snapshot = fixture.snapshot();
  report.history = {
    calls: snapshot.calls,
    failures: snapshot.failures,
    pending: snapshot.pending,
    view: await page
      ?.evaluate(() => {
        const reader = document.querySelector(".messages");
        return {
          focused: document.activeElement === reader,
          scrollTop: reader?.scrollTop,
          scrollHeight: reader?.scrollHeight,
          clientHeight: reader?.clientHeight,
          displayedHistory: document
            .querySelector("[data-fixture-history]")
            ?.getAttribute("data-fixture-history"),
          saved: sessionStorage.getItem("areal-gui:reading-views:v1"),
          trace: window.readingTrace?.slice(-10),
        };
      })
      .catch(() => undefined),
  };
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
