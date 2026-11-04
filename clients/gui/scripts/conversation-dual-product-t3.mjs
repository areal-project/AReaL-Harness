import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { baselineContent } from "./support/conversation-baseline.mjs";
const root = process.cwd();
const dir = process.env.BASELINE_EVIDENCE;
const gate = process.env.BASELINE_GATE;
const source = process.env.BASELINE_SOURCE ?? `${root}/.scratch/dual-product-baseline/t3-src`;
const node =
  process.env.BASELINE_NODE ??
  `${root}/.scratch/dual-product-baseline/toolchain/node_modules/.bin/node`;
const home = process.env.BASELINE_HOME ?? `${root}/.scratch/dual-product-baseline-v2/t3-state`;
const output = execFileSync(node, ["apps/server/src/bin.ts", "pair", "--base-dir", home], {
  cwd: source,
  encoding: "utf8",
  env: {
    PATH: "/usr/bin:/bin",
    HOME: process.env.BASELINE_ISOLATED_HOME ?? `${root}/.scratch/dual-product-baseline-v2/t3-home`,
  },
});
const pair = output.match(/Pairing URL: (\S+)/)?.[1];
if (!pair) throw Error("pair URL unavailable");
const require = createRequire(new URL("../app/package.json", import.meta.url));
const { chromium } = require("playwright-core");
await mkdir(dir, { recursive: true });
await rm(gate, { force: true });
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: false,
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  colorScheme: "dark",
});
const page = await context.newPage();
const results = {};
const logOffset = (await readFile(process.env.BASELINE_LOG, "utf8").catch(() => "")).length;
try {
  await page.goto(pair, { waitUntil: "domcontentloaded", timeout: 60000 });
  results.environment = await page.evaluate(() => ({
    devicePixelRatio,
    colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    font: getComputedStyle(document.body).fontFamily,
    userAgent: navigator.userAgent,
  }));
  await page.getByRole("button", { name: "New thread", exact: true }).waitFor({ timeout: 120000 });
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  const input = page.locator('[contenteditable="true"]').last();
  await input.waitFor({ timeout: 30000 });
  await page.getByText("Baseline short", { exact: true }).waitFor({ timeout: 30000 });
  await page.evaluate(() => {
    window.probe = { samples: [], longtasks: [], frames: [], bodySamples: [] };
    let previous = performance.now();
    const tick = (now) => {
      window.probe.frames.push({ at: now, delta: now - previous });
      previous = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((l) =>
      window.probe.longtasks.push(
        ...l.getEntries().map((x) => ({ start: x.startTime, duration: x.duration })),
      ),
    ).observe({ type: "longtask" });
    window.probe.attach = () => {
      const el = document.querySelector('[contenteditable="true"]');
      if (el.dataset.baselineProbe) return;
      el.dataset.baselineProbe = "1";
      el.addEventListener(
        "keydown",
        (e) => {
          if (e.key !== "x") return;
          const start = performance.now(),
            wall = Date.now(),
            before = el.textContent.length,
            sample = { start, wall, before };
          window.probe.samples.push(sample);
          const obs = new MutationObserver(() => {
            if (el.textContent.length > before) {
              sample.dom = performance.now() - start;
              sample.after = el.textContent.length;
              obs.disconnect();
            }
          });
          obs.observe(el, { childList: true, characterData: true, subtree: true });
          requestAnimationFrame(() => {
            sample.raf = performance.now() - start;
            sample.body = document.body.innerText.length;
          });
        },
        true,
      );
    };
    window.probe.attach();
  });
  async function measure(name, text, prepared = false) {
    if (!prepared) await input.fill(text);
    await input.click();
    await input.press("ControlOrMeta+End");
    await page.evaluate(() => window.probe.attach());
    const start = await page.evaluate(() => window.probe.samples.length);
    for (let i = 0; i < 25; i++) {
      await page.keyboard.type("x");
      await page.waitForTimeout(65);
    }
    await page.waitForTimeout(100);
    results[name] = await page.evaluate(
      ({ start }) => ({
        samples: window.probe.samples.slice(start),
        text: document.querySelector('[contenteditable="true"]').textContent,
        innerText: document.querySelector('[contenteditable="true"]').innerText,
      }),
      { start },
    );
  }
  await measure("shortIdle", baselineContent.shortDraft);
  await measure("longIdle", baselineContent.longDraft);
  await input.fill("BASELINE:STREAM");
  await page.getByRole("button", { name: "Submit message" }).click();
  await page.getByText(/Paragraph 080/).waitFor({ timeout: 120000 });
  await input.fill(baselineContent.longDraft);
  const reading = page.getByText(/Paragraph 040/).first();
  await reading.scrollIntoViewIfNeeded();
  const box = await reading.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 5, { steps: 8 });
  await page.mouse.up();
  await reading.evaluate((el) => {
    let container = el.parentElement;
    while (container && !/(auto|scroll)/.test(getComputedStyle(container).overflowY))
      container = container.parentElement;
    window.probe.messageContainer = container || el.parentElement;
    new MutationObserver(() =>
      window.probe.bodySamples.push({
        at: performance.now(),
        wall: Date.now(),
        length: window.probe.messageContainer.textContent.length,
      }),
    ).observe(window.probe.messageContainer, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  results.selectionBefore = await reading.evaluate((el) => ({
    text: getSelection().toString(),
    y: el.getBoundingClientRect().top,
  }));
  await writeFile(gate, "release\n");
  await page.getByText(/Update 005/).waitFor({ timeout: 30000 });
  results.selectionDuring = await reading.evaluate((el) => ({
    text: getSelection().toString(),
    y: el.getBoundingClientRect().top,
  }));
  await page.screenshot({ path: dir + "/reading-stream.png" });
  await measure("longStream", baselineContent.longDraft, true);
  await page.getByText(/Update 040/).waitFor({ timeout: 30000 });
  results.readingAfter = await reading.evaluate((el) => ({ y: el.getBoundingClientRect().top }));
  await page.screenshot({ path: dir + "/reading-after.png" });
  const end = page.getByRole("button", { name: /Scroll to end/i });
  results.scrollToEndVisible = await end.isVisible();
  if (results.scrollToEndVisible) {
    await end.click();
    results.endVisible = await page.getByText(/Update 040/).isVisible();
  }
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Submit message" }).click();
  const deadline = Date.now() + 30000;
  let promptFound = false;
  let promptText;
  while (Date.now() < deadline) {
    const log = await readFile(process.env.BASELINE_LOG, "utf8").catch(() => "");
    promptFound = log
      .slice(logOffset)
      .split("\n")
      .some((line) => {
        try {
          const item = JSON.parse(line);
          if (item.kind !== "request") return false;
          promptText = item.body.prompt?.find(
            (part) => part.type === "text" && part.text.includes("x".repeat(25)),
          )?.text;
          return promptText !== undefined;
        } catch {
          return false;
        }
      });
    if (promptFound) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  results.promptFound = promptFound;
  results.promptExact = promptText?.replace("x".repeat(25), "") === baselineContent.longDraft;
  results.instrumentation = await page.evaluate(() => ({
    longtasks: window.probe.longtasks,
    frames: window.probe.frames,
    bodySamples: window.probe.bodySamples,
  }));
  await page.screenshot({ path: dir + "/finished.png" });
  await writeFile(dir + "/measurements.json", JSON.stringify(results, null, 2));
  if (
    !promptFound ||
    !results.promptExact ||
    ["shortIdle", "longIdle", "longStream"].some(
      (k) =>
        results[k].samples.length !== 25 ||
        results[k].samples.some((x) => x.dom === undefined || x.after !== x.before + 1),
    )
  )
    throw Error("incomplete sampling or provider prompt");
} catch (e) {
  await page.screenshot({ path: dir + "/failure.png" }).catch(() => {});
  await writeFile(dir + "/failure.txt", String(e.stack));
  await writeFile(dir + "/measurements.json", JSON.stringify(results, null, 2));
  throw e;
} finally {
  await browser.close();
}
