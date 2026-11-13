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
  await checkAnchor("old page is present before unavailable history scenario");
  await page.evaluate(() =>
    fetch("/__reading/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "failNext" }),
    }),
  );
  await page.getByRole("button", { name: "Leave conversation", exact: true }).click();
  const failedHistory = page.waitForResponse(
    (response) =>
      response.url().endsWith("/__reading/history") &&
      response.request().postDataJSON().operation === "ensureAnchor",
  );
  await page.getByRole("button", { name: "Return to conversation", exact: true }).click();
  const failedHistoryResponse = await failedHistory;
  const failedHistoryResult = await failedHistoryResponse.json();
  assert.equal(failedHistoryResult.kind, "limited");
  assert.equal(failedHistoryResult.reason, "unavailable");
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
  await page.getByRole("button", { name: "Reobserve", exact: true }).click();
  await checkAnchor("old page is present before cancellation scenario");
  const holdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/__reading/control") &&
      response.request().postDataJSON().operation === "hold",
  );
  await page.getByRole("button", { name: "Hold pages", exact: true }).click();
  assert.ok((await holdResponse).ok());
  const releaseView = page.waitForResponse(
    (response) =>
      response.url().endsWith("/__reading/history") &&
      response.request().postDataJSON().operation === "release",
  );
  await page.getByRole("button", { name: "Leave conversation", exact: true }).click();
  assert.equal((await (await releaseView).json()).released, true);
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
  const ensureRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/__reading/history") &&
      request.postDataJSON().operation === "ensureAnchor",
  );
  await page.getByRole("button", { name: "Return to conversation", exact: true }).click();
  const ensureHttp = await ensureRequest;
  const ensure = ensureHttp.postDataJSON();
  await until(
    () =>
      page.evaluate(async () => (await (await fetch("/__reading/state")).json()).held.length > 0),
    "history restore request held",
  );
  report.heldRestore = fixture.snapshot().held;
  await page.locator(".messages").hover();
  const retainedResponse = page
    .waitForResponse((response) => {
      if (!response.url().endsWith("/__reading/history")) return false;
      const request = response.request().postDataJSON();
      return (
        request.operation === "retain" &&
        request.viewId === ensure.viewId &&
        request.revision > ensure.revision
      );
    })
    .catch((error) => error);
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
  const olderRequests = [];
  const captureOlder = (request) => {
    if (
      request.url().endsWith("/__reading/history") &&
      request.postDataJSON().operation === "loadOlder"
    )
      olderRequests.push(request);
  };
  page.on("request", captureOlder);
  await page.mouse.wheel(0, -200);
  await page.locator('.messages[data-fixture-wheel-delta="-200"]').waitFor();
  await page.locator('.messages[data-fixture-wheel-end="settled"]').waitFor();
  const retained = await retainedResponse;
  if (retained instanceof Error) throw retained;
  const retainedResult = await retained.json();
  assert.equal(retainedResult.retained, true);
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
    retained: retained.request().postDataJSON(),
    retainedResult,
  };
  await page.evaluate(() =>
    fetch("/__reading/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "release" }),
    }),
  );
  const response = await ensureHttp.response();
  assert.ok(response);
  const result = await response.json();
  report.cancelledRestore = result;
  assert.equal(result.kind, "cancelled");
  await frames();
  for (const request of olderRequests) {
    const response = await request.response();
    assert.ok(response);
    await response.finished();
  }
  page.off("request", captureOlder);
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
    pending: snapshot.pending,
    views: snapshot.views,
    displayHistory: snapshot.thread?.displayHistory,
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
