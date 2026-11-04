import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
async function journeys() {
  const root = process.cwd(),
    base = root + "/.scratch/dual-product-baseline",
    dir = process.env.BASELINE_EVIDENCE
      ? process.env.BASELINE_EVIDENCE + "/journeys"
      : root + "/.scratch/dual-product-baseline-v2/t3-functional",
    node = process.env.BASELINE_NODE ?? base + "/toolchain/node_modules/.bin/node",
    src = process.env.BASELINE_SOURCE ?? base + "/t3-src",
    home = process.env.BASELINE_HOME ?? root + "/.scratch/dual-product-baseline-v2/t3-state",
    workspace =
      process.env.BASELINE_WORKSPACE ?? root + "/.scratch/dual-product-baseline-v2/t3-workspace";
  await mkdir(dir, { recursive: true });
  const pair = () =>
    execFileSync(node, ["apps/server/src/bin.ts", "pair", "--base-dir", home], {
      cwd: src,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME:
          process.env.BASELINE_ISOLATED_HOME ?? root + "/.scratch/dual-product-baseline-v2/t3-home",
      },
    }).match(/Pairing URL: (\S+)/)[1];
  const req = createRequire(new URL("../app/package.json", import.meta.url));
  const { chromium } = req("playwright-core");
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: false,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage(),
    results = {};
  let stage = "setup";
  async function shot(name) {
    await page.screenshot({ path: dir + "/" + name + ".png" });
    await writeFile(dir + "/" + name + ".txt", await page.locator("body").innerText());
  }
  async function fresh() {
    await page.getByRole("button", { name: "New thread", exact: true }).click();
    await page.locator('[contenteditable="true"]').last().waitFor();
    await page.getByText("Baseline short", { exact: true }).waitFor({ timeout: 30000 });
  }
  const editor = () => page.locator('[contenteditable="true"]').last();
  async function send(text) {
    await editor().fill(text);
    await page.getByRole("button", { name: "Submit message" }).click();
    await page.getByText("BASELINE_SHORT_COMPLETE").last().waitFor({ timeout: 30000 });
  }
  try {
    await page.goto(pair());
    await page.getByRole("button", { name: "New thread", exact: true }).waitFor({ timeout: 30000 });
    await fresh();
    await send("B2 seed A");
    stage = "B1";
    await editor().fill("B1 context ");
    await page
      .locator("input[type=file]")
      .setInputFiles([workspace + "/note.txt", workspace + "/image.png"]);
    await page.waitForTimeout(1000);
    await shot("B1-attachments");
    results.B1 = {
      buttons: await page.getByRole("button").allTextContents(),
      preview: await page.getByRole("button", { name: "Preview image.png" }).count(),
      removeFile: await page.getByRole("button", { name: "Remove note.txt" }).count(),
      removeImage: await page.getByRole("button", { name: "Remove image.png" }).count(),
    };
    await editor().click();
    await page.keyboard.type("@note");
    await page.waitForTimeout(1000);
    await shot("B1-mention");
    results.B1.mentionBody = await page.locator("body").innerText();
    if (results.B1.preview !== 1 || !results.B1.mentionBody.includes("note.txt"))
      throw Error("B1 context missing");
    stage = "B3";
    await editor().fill("compose ");
    await editor().focus();
    await editor().evaluate((el) => {
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 229,
          isComposing: true,
          bubbles: true,
        }),
      );
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "字" }));
    });
    results.B3 = { afterComposition: await editor().innerText() };
    await page.keyboard.type("字");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("line");
    results.B3.afterNewline = await editor().innerText();
    await page.keyboard.press("Meta+z");
    results.B3.afterUndo = await editor().innerText();
    await editor().fill("/");
    await page.waitForTimeout(700);
    await shot("B3-slash");
    results.B3.slash = await page.locator("body").innerText();
    await editor().fill("@note");
    await page.waitForTimeout(700);
    await shot("B3-mention");
    results.B3.mention = await page.locator("body").innerText();
    if (
      results.B3.afterComposition !== "compose " ||
      !results.B3.slash.includes("/model") ||
      !results.B3.mention.includes("note.txt")
    )
      throw Error("B3 input or menu mismatch");
    stage = "B6";
    await editor().fill("BASELINE:RICH");
    await page.getByRole("button", { name: "Submit message" }).click();
    await page.getByText("Result reading").last().waitFor({ timeout: 30000 });
    await page.waitForTimeout(1000);
    await shot("B6-rich");
    results.B6 = {
      body: await page.locator("body").innerText(),
      buttons: await page.getByRole("button").allTextContents(),
      svg: await page.locator("svg").count(),
      tables: await page.locator("table").count(),
    };
  } catch (e) {
    process.exitCode = 1;
    results.error = { stage, stack: String(e.stack) };
    await shot("failure-" + stage).catch(() => {});
  } finally {
    await writeFile(dir + "/results.json", JSON.stringify(results, null, 2));
    await browser.close();
  }
}
async function contextRich() {
  const root = process.cwd(),
    base = root + "/.scratch/dual-product-baseline",
    dir = process.env.BASELINE_EVIDENCE
      ? process.env.BASELINE_EVIDENCE + "/context-rich"
      : root + "/.scratch/dual-product-baseline-v2/t3-context-rich",
    node = process.env.BASELINE_NODE ?? base + "/toolchain/node_modules/.bin/node",
    src = process.env.BASELINE_SOURCE ?? base + "/t3-src",
    home = process.env.BASELINE_HOME ?? root + "/.scratch/dual-product-baseline-v2/t3-state",
    workspace =
      process.env.BASELINE_WORKSPACE ?? root + "/.scratch/dual-product-baseline-v2/t3-workspace",
    gate = process.env.BASELINE_GATE ?? root + "/.scratch/dual-product-baseline-v2/t3-gate-prod";
  await mkdir(dir, { recursive: true });
  const pair = () =>
    execFileSync(node, ["apps/server/src/bin.ts", "pair", "--base-dir", home], {
      cwd: src,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME:
          process.env.BASELINE_ISOLATED_HOME ?? root + "/.scratch/dual-product-baseline-v2/t3-home",
      },
    }).match(/Pairing URL: (\S+)/)[1];
  const req = createRequire(new URL("../app/package.json", import.meta.url));
  const { chromium } = req("playwright-core");
  const profile = dir + "/profile";
  let context = await chromium.launchPersistentContext(profile, {
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: false,
      viewport: { width: 1280, height: 800 },
      permissions: ["clipboard-read", "clipboard-write"],
    }),
    page = context.pages()[0],
    results = {},
    stage = "setup";
  const ed = () => page.locator('[contenteditable="true"]').last();
  const snap = async (n) => {
    await page.screenshot({ path: dir + "/" + n + ".png" });
    await writeFile(dir + "/" + n + ".txt", await page.locator("body").innerText());
  };
  async function fresh() {
    await page.getByRole("button", { name: "New thread", exact: true }).click();
    await ed().waitFor();
    await page.getByText("Baseline short", { exact: true }).waitFor({ timeout: 30000 });
  }
  async function send(t) {
    await ed().fill(t);
    await page.getByRole("button", { name: "Submit message" }).click();
    await page.getByText("BASELINE_SHORT_COMPLETE").last().waitFor({ timeout: 30000 });
  }
  try {
    await page.goto(pair());
    await page.getByRole("button", { name: "New thread", exact: true }).waitFor({ timeout: 30000 });
    await fresh();
    await send("B2 retain A");
    const urlA = page.url();
    await ed().fill("B2 retain context");
    await page
      .locator("input[type=file]")
      .setInputFiles([workspace + "/note.txt", workspace + "/image.png"]);
    await page.waitForTimeout(500);
    await snap("before-switch");
    await fresh();
    await send("B2 retain B");
    const urlB = page.url();
    await ed().fill("B2 separate B");
    await page.goto(urlA);
    await ed().waitFor();
    await page.waitForTimeout(500);
    results.returnA = {
      text: await ed().innerText(),
      body: await page.locator("body").innerText(),
      html: await ed().innerHTML(),
    };
    await snap("return-A");
    await page.reload();
    await ed().waitFor();
    await page.waitForTimeout(500);
    results.reloadA = {
      text: await ed().innerText(),
      body: await page.locator("body").innerText(),
      html: await ed().innerHTML(),
    };
    await snap("reload-A");
    await context.close();
    context = await chromium.launchPersistentContext(profile, {
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: false,
      viewport: { width: 1280, height: 800 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    page = context.pages()[0];
    await page.goto(urlA);
    await ed().waitFor({ timeout: 30000 });
    await page.waitForTimeout(1000);
    results.reopenA = {
      text: await ed().innerText(),
      body: await page.locator("body").innerText(),
      html: await ed().innerHTML(),
    };
    await snap("reopen-A");
    await page.getByRole("button", { name: "Submit message" }).click();
    await page.getByText("BASELINE_SHORT_COMPLETE").last().waitFor({ timeout: 30000 });
    await page.waitForTimeout(500);
    await snap("sent-context");
    stage = "rich";
    await page.goto(urlB);
    await ed().waitFor();
    await rm(gate, { force: true });
    await ed().fill("BASELINE:RICH");
    await page.getByRole("button", { name: "Submit message" }).click();
    await page.getByRole("button", { name: "Expand diagram" }).waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "Expand diagram" }).click();
    await page.waitForTimeout(500);
    await snap("diagram-stream");
    results.diagramStream = {
      body: await page.locator("body").innerText(),
      buttons: await page.locator("button").evaluateAll((es) =>
        es
          .map((e) => ({
            label: e.getAttribute("aria-label"),
            title: e.getAttribute("title"),
            text: e.innerText,
          }))
          .filter((e) => e.label || e.title),
      ),
    };
    await writeFile(gate, "release\n");
    await page.waitForTimeout(1000);
    await snap("diagram-complete");
    results.diagramComplete = await page.locator("body").innerText();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Copy table" }).click();
    await page.getByRole("menuitem", { name: "Copy as Markdown" }).click();
    results.tableMarkdown = await page.evaluate(() => navigator.clipboard.readText());
    await writeFile(dir + "/table.md", results.tableMarkdown);
    await page.getByRole("button", { name: /Copy table|Copied/ }).click();
    await page.getByRole("menuitem", { name: "Copy as CSV" }).click();
    results.tableCSV = await page.evaluate(() => navigator.clipboard.readText());
    await writeFile(dir + "/table.csv", results.tableCSV);
    await snap("table-copy");
    if (
      [results.returnA, results.reloadA, results.reopenA].some(
        (v) => !v.text.includes("note.txt") || !v.text.includes("image.png"),
      )
    )
      throw Error("B2 context missing");
    if (!results.tableMarkdown.includes("| row-30 |") || !results.tableCSV.includes("row-30,"))
      throw Error("B6 copied table incomplete");
  } catch (e) {
    process.exitCode = 1;
    results.error = { stage, stack: String(e.stack) };
    await snap("failure-" + stage).catch(() => {});
  } finally {
    await writeFile(dir + "/results.json", JSON.stringify(results, null, 2));
    await context.close();
  }
}
async function boundary() {
  const root = process.cwd(),
    base = root + "/.scratch/dual-product-baseline",
    dir = process.env.BASELINE_EVIDENCE
      ? process.env.BASELINE_EVIDENCE + "/boundary"
      : root + "/.scratch/dual-product-baseline-v2/t3-boundary-retry-02",
    node = process.env.BASELINE_NODE ?? base + "/toolchain/node_modules/.bin/node",
    src = process.env.BASELINE_SOURCE ?? base + "/t3-src",
    home = process.env.BASELINE_HOME ?? root + "/.scratch/dual-product-baseline-v2/t3-state",
    log =
      process.env.BASELINE_LOG ??
      root + "/.scratch/dual-product-baseline-v2/t3-provider-prod.jsonl";
  await mkdir(dir, { recursive: true });
  const pair = () =>
    execFileSync(node, ["apps/server/src/bin.ts", "pair", "--base-dir", home], {
      cwd: src,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME:
          process.env.BASELINE_ISOLATED_HOME ?? root + "/.scratch/dual-product-baseline-v2/t3-home",
      },
    }).match(/Pairing URL: (\S+)/)[1];
  const require = createRequire(new URL("../app/package.json", import.meta.url)),
    { chromium } = require("playwright-core"),
    browser = await chromium.launch({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: false,
    }),
    results = {};
  for (const mode of ["before", "after"]) {
    const baselineLog = (await readFile(log, "utf8").catch(() => "")).length;
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }),
      page = await context.newPage();
    let armed = false,
      targetId = null,
      hit = false;
    const wire = [];
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((msg) => {
        let m;
        try {
          m = JSON.parse(String(msg));
        } catch {}
        if (
          !armed &&
          hit &&
          m?._tag === "Request" &&
          m.tag === "orchestration.dispatchCommand" &&
          JSON.stringify(m.payload).includes("B4 retry " + mode)
        ) {
          wire.push({ direction: "retryRequest", message: m });
        }
        if (
          armed &&
          m?._tag === "Request" &&
          m.tag === "orchestration.dispatchCommand" &&
          JSON.stringify(m.payload).includes("B4 retry " + mode)
        ) {
          targetId = m.id;
          wire.push({ direction: "request", message: m });
          if (mode === "before" && !hit) {
            hit = true;
            void ws.close();
            void server.close();
            return;
          }
        }
        server.send(msg);
      });
      server.onMessage((msg) => {
        let m;
        try {
          m = JSON.parse(String(msg));
        } catch {}
        if (
          mode === "after" &&
          !hit &&
          targetId !== null &&
          m?._tag === "Exit" &&
          m.requestId === targetId &&
          m.exit?._tag === "Success"
        ) {
          wire.push({ direction: "ack", message: m });
          hit = true;
          void ws.close();
          void server.close();
          return;
        }
        ws.send(msg);
      });
    });
    try {
      await page.goto(pair());
      await page
        .getByRole("button", { name: "New thread", exact: true })
        .waitFor({ timeout: 30000 });
      await page.getByRole("button", { name: "New thread", exact: true }).click();
      await page.getByText("Baseline short", { exact: true }).waitFor({ timeout: 30000 });
      const input = page.locator('[contenteditable="true"]').last();
      await input.fill("B4 retry seed " + mode);
      await page.getByRole("button", { name: "Submit message" }).click();
      await page.getByText("BASELINE_SHORT_COMPLETE").last().waitFor({ timeout: 30000 });
      await input.fill("B4 retry " + mode + " unique");
      armed = true;
      await page.getByRole("button", { name: "Submit message" }).click();
      for (let i = 0; i < 100 && !hit; i++) await page.waitForTimeout(100);
      if (!hit) throw Error("Fault did not hit dispatch boundary");
      await page.waitForTimeout(1500);
      results[mode] = {
        hit,
        wire,
        body: await page.locator("body").innerText(),
        draft: await input.innerText().catch(() => null),
      };
      await page.screenshot({ path: dir + "/" + mode + ".png" });
      results[mode].requests = (await readFile(log, "utf8"))
        .slice(baselineLog)
        .split("\n")
        .filter((line) => line.includes("B4 retry " + mode + " unique"))
        .map((line) => JSON.parse(line));
      armed = false;
      await page.reload();
      await input.waitFor({ timeout: 30000 });
      await page.waitForTimeout(1500);
      results[mode].recovery = {
        body: await page.locator("body").innerText(),
        draft: await input.innerText(),
      };
      await page.screenshot({ path: dir + "/" + mode + "-recovered.png" });
      if ((await input.innerText()).includes("B4 retry " + mode + " unique")) {
        await page.getByRole("button", { name: "Submit message" }).click();
        const countBefore = results[mode].requests.length;
        for (let i = 0; i < 100; i++) {
          const count = (await readFile(log, "utf8"))
            .slice(baselineLog)
            .split("\n")
            .filter((line) => line.includes("B4 retry " + mode + " unique")).length;
          if (count > countBefore) break;
          await page.waitForTimeout(100);
        }
        results[mode].retry = {
          body: await page.locator("body").innerText(),
          draft: await input.innerText(),
          requests: (await readFile(log, "utf8"))
            .slice(baselineLog)
            .split("\n")
            .filter((line) => line.includes("B4 retry " + mode + " unique"))
            .map((line) => JSON.parse(line)),
        };
        await page.screenshot({ path: dir + "/" + mode + "-retry.png" });
        if (mode === "after" && results[mode].retry.requests.length > 1)
          throw Error("Accepted request was executed again after retry");
      }
    } catch (e) {
      process.exitCode = 1;
      results[mode] = { ...results[mode], hit, wire, error: String(e.stack) };
      await page.screenshot({ path: dir + "/" + mode + "-failure.png" }).catch(() => {});
    } finally {
      await context.close();
      await writeFile(dir + "/results.json", JSON.stringify(results, null, 2));
    }
  }
  await browser.close();
}

const selected = process.argv[2] ?? "all";
if (selected === "all" || selected === "journeys") await journeys();
if (selected === "all" || selected === "context-rich") await contextRich();
if (selected === "all" || selected === "boundary") await boundary();
