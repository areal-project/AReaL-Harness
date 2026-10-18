// 真实模型网页实验：生成端只负责产物，独立浏览器生成固定 rubric 回执。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { connect } from "../examples/desktop-api/client.mjs";
const require = createRequire(new URL("../clients/gui/app/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const [configArg, outputArg, planArg] = process.argv.slice(2);
assert(
  configArg && outputArg,
  "usage: node scripts/rsi-web-live.mjs CONFIG OUTPUT [EVOLUTION_PLAN.json]",
);
const output = resolve(outputArg),
  privateDir = join(output, ".private"),
  workspace = join(privateDir, "workspace"),
  data = join(privateDir, "data");
await mkdir(workspace, { recursive: true, mode: 0o700 });
await mkdir(join(privateDir, "user"), { recursive: true });
await writeFile(
  join(workspace, "brief.txt"),
  "MOSS / 城市之外 — weekend field trips. Independent browser acceptance; no network assets.\n",
);
const rubric = {
  id: "web-experience-v1",
  checks: [
    "desktopNoOverflow",
    "mobileNoOverflow",
    "semanticMain",
    "filterWorks",
    "saveWorks",
    "bookingOpens",
    "bookingSubmits",
    "escapeCloses",
    "themePersists",
    "noRuntimeErrors",
    "offlineAssets",
  ],
  viewports: [
    [1440, 1000],
    [390, 844],
  ],
  note: "功能回归，不代表审美评分；生成端不能修改此评测脚本。",
};
await writeFile(join(output, "rubric.json"), JSON.stringify(rubric, null, 2));
const objective = `Design and build a beautiful, production-quality standalone landing page for MOSS / 城市之外, an editorial weekend outdoor experiences club. Make it feel like a premium independent travel magazine: memorable typography, art-directed imagery drawn using inline SVG/CSS, thoughtful spacing, a strong green/ivory/ochre palette, a large expressive hero, and 4 detailed experience cards. Use real Chinese content with small English editorial labels. Work offline with no external assets. Responsive at 1440 and 390px. Include functioning type filters, save-to-itinerary toggles, a booking dialog with name/email validation and confirmation, a persistent light/dark theme toggle, and keyboard-accessible controls. Return only the HTML artifact at the assigned writable path.
Interaction contract (stable test hooks, visible text can vary): one main; cards [data-testid="experience-card"] with data-category=forest or coast (2 each); filter buttons [data-filter="all"], [data-filter="forest"], [data-filter="coast"] hide nonmatches; card save buttons [data-action="save"] toggle aria-pressed=true/false; card booking buttons [data-action="book"] open dialog [data-testid="booking-dialog"]; dialog input[name="name"], input[name="email"], button[type="submit"]; on valid submit show visible [data-testid="booking-success"] (confirmation may be inside or outside dialog). Escape dismisses dialog and returns focus to invoking book button. [data-testid="theme-toggle"] toggles document.documentElement.dataset.theme between light and dark and persists across reload. Prevent horizontal overflow. All controls must work; decoration should not obscure content.`;
let child, rpc, browser, server;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pages = new Map();
async function start() {
  child = spawn(
    "/usr/bin/python3",
    [
      "scripts/launch.py",
      "--bin-dir",
      resolve("target/debug"),
      "--config",
      resolve(configArg),
      "--listen",
      "127.0.0.1:0",
      "--data-dir",
      data,
      "--workspace",
      workspace,
      "--allow-write",
      "--permissions",
      "yolo",
      "--model-concurrency",
      "3",
    ],
    {
      env: {
        ...process.env,
        HOME: join(privateDir, "user"),
        AREAL_HARNESS_HOME: join(privateDir, "harness"),
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stderr.on("data", (d) => {
    log += d;
  });
  child.stdout.on("data", (d) => {
    log += d;
  });
  const end = Date.now() + 60000;
  while (!/ws:\/\/127\.0\.0\.1:\d+/.test(log)) {
    assert(
      child.exitCode === null && Date.now() < end,
      `Core startup failed (private log): ${log.slice(-2000)}`,
    );
    await sleep(100);
  }
  rpc = await connect(log.match(/ws:\/\/127\.0\.0\.1:\d+/)[0], join(data, "security/auth.json"));
  await rpc.call("areal/capabilities");
  server = createServer((req, res) => {
    const html = pages.get(req.url.split("?")[0]);
    if (!html) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  browser = await chromium.launch({ headless: true });
  return () => log;
}
async function settle(threadId) {
  const end = Date.now() + 900000;
  let count = -1;
  while (Date.now() < end) {
    const value = await rpc.call("areal/goal/get", { threadId });
    const cs = value.goal.rsi.candidates;
    const done = cs.filter((c) => !["queued", "running"].includes(c.status)).length;
    if (done !== count) {
      count = done;
      console.log(JSON.stringify({ stage: "running", settled: done, total: cs.length }));
    }
    if (value.goal.rsi.phase !== "running") return value;
    await sleep(1000);
  }
  throw Error("real model run exceeded 15 minute deadline");
}
async function artifact(threadId, goalId, candidateId) {
  const chunks = [];
  let offset = 0,
    sha;
  for (;;) {
    const page = await rpc.call("areal/goal/candidateArtifact", {
      threadId,
      goalId,
      candidateId,
      offset,
    });
    chunks.push(Buffer.from(page.dataBase64, "base64"));
    sha = page.sha256;
    if (page.complete) break;
    assert(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  const bytes = Buffer.concat(chunks);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sha);
  return { bytes, sha };
}
async function evaluate(candidate, html) {
  pages.set(`/${candidate.id}`, html);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage(),
    errors = [],
    remote = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (!url.startsWith("http://127.0.0.1:") && !url.startsWith("data:")) {
      remote.push(url);
      return route.abort();
    }
    return route.continue();
  });
  const checks = {},
    details = {};
  const check = async (name, fn) => {
    try {
      checks[name] = !!(await fn());
    } catch (e) {
      checks[name] = false;
      details[name] = e.message.slice(0, 400);
    }
  };
  page.setDefaultTimeout(2500);
  await page.goto(`http://127.0.0.1:${server.address().port}/${candidate.id}`, {
    waitUntil: "networkidle",
  });
  await check("desktopNoOverflow", () =>
    page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  );
  await check("semanticMain", async () => (await page.locator("main").count()) === 1);
  await page.screenshot({ path: join(output, `${candidate.id}-desktop.png`), fullPage: true });
  await check("filterWorks", async () => {
    await page.locator('[data-filter="forest"]').click();
    const visible = page.locator('[data-testid="experience-card"]:visible');
    const ok =
      (await visible.count()) === 2 &&
      (await visible.evaluateAll((es) => es.map((e) => e.dataset.category))).every(
        (x) => x === "forest",
      );
    await page.locator('[data-filter="all"]').click();
    return ok && (await visible.count()) === 4;
  });
  await check("saveWorks", async () => {
    const b = page.locator('[data-action="save"]').first();
    const initial = await b.getAttribute("aria-pressed");
    await b.click();
    return (await b.getAttribute("aria-pressed")) === (initial === "true" ? "false" : "true");
  });
  const dialog = page.locator('[data-testid="booking-dialog"]');
  await check("bookingOpens", async () => {
    await page.locator('[data-action="book"]').first().click();
    return await dialog.isVisible();
  });
  await check("bookingSubmits", async () => {
    await dialog.locator('[name="name"]').fill("测试用户");
    await dialog.locator('[name="email"]').fill("rsi@example.test");
    await dialog.locator('[type="submit"]').click();
    await page.locator('[data-testid="booking-success"]').waitFor({ state: "visible" });
    return true;
  });
  await page.keyboard.press("Escape");
  await check("escapeCloses", async () => {
    const b = page.locator('[data-action="book"]').first();
    await b.click();
    await page.keyboard.press("Escape");
    return !(await dialog.isVisible()) && (await b.evaluate((e) => e === document.activeElement));
  });
  await check("themePersists", async () => {
    const before = await page.locator("html").getAttribute("data-theme");
    await page.locator('[data-testid="theme-toggle"]').click();
    const after = await page.locator("html").getAttribute("data-theme");
    await page.reload({ waitUntil: "networkidle" });
    return (
      ["light", "dark"].includes(after) &&
      after !== before &&
      (await page.locator("html").getAttribute("data-theme")) === after
    );
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await check("mobileNoOverflow", () =>
    page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  );
  await page.screenshot({ path: join(output, `${candidate.id}-mobile.png`), fullPage: true });
  checks.noRuntimeErrors = errors.length === 0;
  checks.offlineAssets = remote.length === 0;
  await context.close();
  const score = Math.round(
    (100 * Object.values(checks).filter(Boolean).length) / rubric.checks.length,
  );
  return {
    rubricId: rubric.id,
    evaluator: "Playwright Chromium / independent script",
    taskId: "moss-weekend-page",
    artifactSha256: createHash("sha256").update(html).digest("hex"),
    checks,
    score,
    feedback: `Browser functional acceptance: ${Object.values(checks).filter(Boolean).length}/${rubric.checks.length}. Failed checks: ${
      Object.entries(checks)
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(", ") || "none"
    }. Aesthetic quality is reviewed separately from this score.`,
    evidence: [
      `${candidate.id}-browser.json`,
      `${candidate.id}-desktop.png`,
      `${candidate.id}-mobile.png`,
    ],
    details,
    errors,
    remote,
  };
}
let log;
try {
  log = await start();
  let run;
  try {
    run = JSON.parse(await readFile(join(output, "run.json"), "utf8"));
  } catch {}
  let view;
  if (!run) {
    const thread = await rpc.call("thread/start", {});
    run = {
      threadId: thread.thread.id,
      objective,
      startedAt: new Date().toISOString(),
      model: "configured real provider; no fixture",
    };
    await writeFile(join(output, "run.json"), JSON.stringify(run, null, 2));
    view = await rpc.call("areal/goal/create", {
      requestId: randomUUID(),
      threadId: run.threadId,
      expectedRevision: 0,
      objective,
      workflow: "rsiArtifact",
      outputFormat: "html",
      maxActiveSeconds: 1200,
      tokenBudget: 400000,
    });
    console.log(JSON.stringify({ stage: "created", threadId: run.threadId, goalId: view.goal.id }));
  } else {
    view = await rpc.call("areal/goal/get", { threadId: run.threadId });
    if (planArg) {
      const plan = JSON.parse(await readFile(resolve(planArg), "utf8"));
      view = await rpc.call("areal/goal/evolve", {
        requestId: randomUUID(),
        threadId: run.threadId,
        goalId: view.goal.id,
        expectedRevision: view.revision,
        ...plan,
      });
    }
  }
  view = await settle(run.threadId);
  for (const c of view.goal.rsi.candidates.filter(
    (c) => ["completed", "selected"].includes(c.status) && !c.evaluations.length,
  )) {
    const { bytes, sha } = await artifact(run.threadId, view.goal.id, c.id);
    await writeFile(join(output, `${c.id}.html`), bytes);
    const evaluation = await evaluate(c, bytes);
    assert.equal(evaluation.artifactSha256, sha);
    await writeFile(join(output, `${c.id}-browser.json`), JSON.stringify(evaluation, null, 2));
    const { details, errors, remote, ...receipt } = evaluation;
    view = await rpc.call("areal/goal/evaluateCandidate", {
      requestId: randomUUID(),
      threadId: run.threadId,
      goalId: view.goal.id,
      expectedRevision: view.revision,
      candidateId: c.id,
      evaluation: receipt,
    });
    console.log(
      JSON.stringify({
        stage: "evaluated",
        candidate: c.id,
        score: evaluation.score,
        checks: evaluation.checks,
      }),
    );
  }
  const ready = view.goal.rsi.candidates.filter((c) =>
    ["completed", "selected"].includes(c.status),
  );
  assert(
    ready.length,
    JSON.stringify(view.goal.rsi.candidates.map((c) => ({ id: c.id, error: c.error }))),
  );
  const best = ready.sort(
    (a, b) =>
      (b.evaluations.at(-1)?.score ?? 0) - (a.evaluations.at(-1)?.score ?? 0) ||
      b.round - a.round ||
      b.id.localeCompare(a.id),
  )[0];
  if (view.goal.rsi.phase === "awaitingSelection")
    view = await rpc.call("areal/goal/selectCandidate", {
      requestId: randomUUID(),
      threadId: run.threadId,
      goalId: view.goal.id,
      expectedRevision: view.revision,
      candidateId: best.id,
    });
  await writeFile(join(output, "exploration.json"), JSON.stringify(view, null, 2));
  await copyFile(
    join(output, `${view.goal.rsi.selectedCandidateId}.html`),
    join(output, "winner.html"),
  );
  await writeFile(
    join(output, "binary.json"),
    JSON.stringify(
      {
        sha256: createHash("sha256")
          .update(await readFile("target/debug/areal"))
          .digest("hex"),
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      stage: "complete",
      winner: view.goal.rsi.selectedCandidateId,
      versions: ready.length,
      usage: view.goal.usage,
      output,
    }),
  );
} finally {
  if (log) await writeFile(join(privateDir, "core.log"), log(), { mode: 0o600 });
  rpc?.close();
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((r) => child.once("exit", r)),
      sleep(15000).then(() => child.kill("SIGKILL")),
    ]);
  }
}
