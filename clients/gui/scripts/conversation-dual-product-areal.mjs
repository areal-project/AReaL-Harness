import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadavg } from "node:os";
import { makeTempDir } from "./support/temp.mjs";
import { baselineContent } from "./support/conversation-baseline.mjs";
import { createBaselineServer } from "./support/conversation-baseline-provider.mjs";
import { applicationFixture } from "./application-fixture.mjs";
import { captureSmokeFailure, createProjectConversation } from "./smoke-navigation.mjs";

const gui = resolve(import.meta.dirname, "..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const execute = promisify(execFile);
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../.local/dev-bin/areal");
const state = await makeTempDir("acr-");
const evidence = process.env.AREAL_CONTENT_READING_EVIDENCE || state;
await mkdir(evidence, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const binaryHash = hash(await readFile(binary));
const checks = [],
  errors = [];
const gatePath = join(evidence, "release-gate");
const model = createBaselineServer({ logPath: join(evidence, "provider.jsonl"), gatePath });
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_BIN: binary,
  AREAL_GUI_USER_DATA: join(state, "electron"),
  AREAL_CORE_HOME: join(state, "core"),
  AREAL_CORE_USER_HOME: join(state, "user"),
  AREAL_HARNESS_HOME: join(state, "config-home"),
  AREAL_HARNESS_SERVICE_HOME: join(state, "registry"),
  AREAL_CORE_CONFIG: join(state, "config.toml"),
  AREAL_CORE_DESKTOP_CONFIG: join(state, "desktop.json"),
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
});
const workspace = join(state, "workspace");
let fixture,
  app,
  page,
  passed = false;
async function sampleTyping(page, input, label) {
  await input.click();
  await input.press("ControlOrMeta+End");
  await input.evaluate((element) => {
    const state = { samples: [], pending: [] };
    const observer = new MutationObserver(() => {
      const now = performance.now();
      for (const sample of state.pending)
        if (!sample.mutation && element.textContent.length > sample.inputLength)
          sample.mutation = now;
    });
    observer.observe(element, { subtree: true, childList: true, characterData: true });
    const handler = (event) => {
      if (event.key !== "x") return;
      const start = performance.now(),
        wallTime = Date.now(),
        inputLength = element.textContent.length;
      const sample = {
        start,
        wallTime,
        inputLength,
        messageLength: document.querySelector(".messages")?.textContent?.length,
      };
      state.samples.push(sample);
      state.pending.push(sample);
      requestAnimationFrame(() => {
        sample.raf = performance.now();
        sample.delta = sample.raf - start;
        sample.inputLengthAtRaf = element.textContent.length;
        sample.messageLengthAtRaf = document.querySelector(".messages")?.textContent?.length;
      });
    };
    element.addEventListener("keydown", handler, true);
    window.typingProbe = { state, observer, handler, element };
  });
  for (let i = 0; i < 25; i++) {
    await page.keyboard.type("x");
    await page.waitForTimeout(65);
  }
  const samples = await page.evaluate(() => {
    const p = window.typingProbe;
    p.observer.disconnect();
    p.element.removeEventListener("keydown", p.handler, true);
    return p.state.samples;
  });
  assert.equal(samples.length, 25, `${label} samples`);
  await writeFile(join(evidence, `${label}.json`), JSON.stringify(samples, null, 2));
}
console.log(`Evidence: ${evidence}`);
try {
  await mkdir(workspace);
  await mkdir(join(state, "user"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  await writeFile(
    join(state, "config.toml"),
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
  );
  await writeFile(
    join(state, "desktop.json"),
    JSON.stringify({
      profiles: [
        {
          id: "fixture",
          revision: "v1",
          displayName: "Fixture",
          instructions: "Respond to the task.",
        },
      ],
    }),
  );
  fixture = await applicationFixture(gui, join(state, "app"));
  app = await electron.launch({
    executablePath: require("electron"),
    args: [fixture.path],
    env,
    timeout: 120000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  await page.waitForFunction(() => innerWidth === 1280 && innerHeight === 800);
  const environment = {
    viewport: await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      pixelRatio: devicePixelRatio,
      theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    })),
    versions: await app.evaluate(() => process.versions),
    loadavg: loadavg(),
  };
  await writeFile(join(evidence, "environment.json"), JSON.stringify(environment, null, 2));
  await page.waitForFunction(
    async () => (await window.arealDesktop.snapshot()).connection?.state === "ready",
  );
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await page.waitForFunction(
    async (root) =>
      (await window.arealDesktop.snapshot()).projects.some(
        (p) => p.root === root && p.state?.connected,
      ),
    workspace,
  );
  await page.waitForFunction(async (root) => {
    const project = (await window.arealDesktop.snapshot()).projects.find((p) => p.root === root);
    return (
      project &&
      document.querySelector('[data-testid="areal-workbench"]')?.dataset.projectId === project.id
    );
  }, workspace);
  await createProjectConversation(page, "workspace");
  const preInput = page.getByTestId("chat-input");
  await preInput.fill(baselineContent.shortDraft);
  await sampleTyping(page, preInput, "short-idle");
  await preInput.fill("BASELINE:STREAM");
  await page.getByTestId("chat-send-button").click();
  await page.getByText(/Paragraph 080/).waitFor({ timeout: 120000 });
  const reader = page.locator(".messages");
  await reader.waitFor();
  await page.screenshot({ path: join(evidence, "01-stream-initial.png"), scale: "css" });
  await reader.hover();
  const beforeWheel = await reader.evaluate((e) => ({
    top: e.scrollTop,
    height: e.scrollHeight,
    client: e.clientHeight,
  }));
  await page.mouse.wheel(0, -700);
  await page.waitForTimeout(600);
  const afterWheel = await reader.evaluate((e) => ({
    top: e.scrollTop,
    height: e.scrollHeight,
    client: e.clientHeight,
  }));
  assert.ok(
    afterWheel.top < beforeWheel.top - 20,
    `wheel must move upward ${JSON.stringify({ beforeWheel, afterWheel })}`,
  );
  await page.screenshot({ path: join(evidence, "02-reading-before-growth.png"), scale: "css" });
  const input = page.getByTestId("chat-input");
  await input.click();
  const largeText = baselineContent.longDraft;
  await input.evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, largeText);
  await page.getByRole("button", { name: "在文本框中显示 ›" }).click();
  await page.waitForFunction(
    (text) =>
      document.querySelector('[data-testid="chat-input"]')?.textContent ===
      text.replaceAll("\n", ""),
    largeText,
  );
  await sampleTyping(page, input, "long-idle");
  for (let i = 0; i < 25; i++) await page.keyboard.press("Backspace");
  await page.waitForFunction(
    (text) =>
      document.querySelector('[data-testid="chat-input"]')?.textContent ===
      text.replaceAll("\n", ""),
    largeText,
  );
  const anchor = await reader.evaluate((e) => {
    const bounds = e.getBoundingClientRect();
    const n = [...e.querySelectorAll("p")].find(
      (x) =>
        x.textContent?.includes("Paragraph ") &&
        x.getBoundingClientRect().top >= bounds.top + 10 &&
        x.getBoundingClientRect().bottom < bounds.bottom - 10,
    );
    if (!n) throw Error("no visible paragraph");
    const t = n.firstChild;
    const range = document.createRange();
    range.setStart(t, 0);
    range.setEnd(t, Math.min(12, t.length));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return { text: n.textContent, y: n.getBoundingClientRect().top, selected: sel.toString() };
  });
  await page.evaluate(() => {
    window.audit = { samples: [], longtasks: [], mutations: [] };
    window.audit.observer = new PerformanceObserver((list) =>
      window.audit.longtasks.push(
        ...list.getEntries().map((x) => ({ start: x.startTime, duration: x.duration })),
      ),
    );
    window.audit.observer.observe({ type: "longtask" });
    window.audit.mo = new MutationObserver(() =>
      window.audit.mutations.push({
        time: performance.now(),
        length: document.querySelector(".messages")?.textContent?.length,
      }),
    );
    window.audit.mo.observe(document.querySelector(".messages"), {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await writeFile(gatePath, "release\n");
  await page.getByText(/Update 005/).waitFor({ timeout: 30000 });
  const during = await reader.evaluate((e, a) => {
    const n = [...e.querySelectorAll("p")].find((x) => x.textContent === a.text);
    return {
      y: n?.getBoundingClientRect().top,
      selected: getSelection().toString(),
      top: e.scrollTop,
      height: e.scrollHeight,
    };
  }, anchor);
  await page.screenshot({ path: join(evidence, "03-growth-selection.png"), scale: "css" });
  await writeFile(
    join(evidence, "anchor-during.json"),
    JSON.stringify({ beforeWheel, afterWheel, anchor, during }, null, 2),
  );
  assert.equal(during.selected, anchor.selected, "selection survives stream growth");
  assert.ok(
    Math.abs(during.y - anchor.y) <= 2,
    `stream anchor displacement ${during.y - anchor.y}`,
  );
  await sampleTyping(page, input, "long-stream");
  const typed = await input.textContent();
  await page.getByText(/Update 040/).waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  const finished = await reader.evaluate((e, a) => {
    const n = [...e.querySelectorAll("p")].find((x) => x.textContent === a.text);
    return {
      y: n?.getBoundingClientRect().top,
      top: e.scrollTop,
      height: e.scrollHeight,
      client: e.clientHeight,
    };
  }, anchor);
  const metrics = await page.evaluate(() => {
    window.audit.observer.disconnect();
    window.audit.mo.disconnect();
    return { longtasks: window.audit.longtasks, mutations: window.audit.mutations };
  });
  await writeFile(
    join(evidence, "measurements.json"),
    JSON.stringify({ anchor, during, finished, typed, metrics }, null, 2),
  );
  await page.screenshot({ path: join(evidence, "04-finished-reading.png"), scale: "css" });
  assert.equal(typed.replace("x".repeat(25), ""), largeText.replaceAll("\n", ""));
  assert.equal(typed.length, largeText.replaceAll("\n", "").length + 25);
  assert.ok(
    Math.abs(finished.y - anchor.y) <= 2,
    `completion anchor displacement ${finished.y - anchor.y}`,
  );
  await page.getByRole("button", { name: "滚动到底部" }).click();
  await page.waitForTimeout(500);
  const bottom = await reader.evaluate((e) => ({
    top: e.scrollTop,
    height: e.scrollHeight,
    client: e.clientHeight,
    remaining: e.scrollHeight - e.scrollTop - e.clientHeight,
  }));
  await writeFile(join(evidence, "bottom.json"), JSON.stringify(bottom, null, 2));
  await page.screenshot({ path: join(evidence, "05-explicit-bottom.png"), scale: "css" });
  assert.ok(bottom.remaining <= 2, `explicit bottom: ${JSON.stringify(bottom)}`);
  await page.getByTestId("chat-send-button").click();
  const deadline = Date.now() + 15000;
  let lastRequest;
  while (Date.now() < deadline && !lastRequest) {
    const providerLog = (await readFile(join(evidence, "provider.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    lastRequest = providerLog
      .filter((entry) => entry.kind === "request" && entry.scenario === "short")
      .findLast((entry) =>
        entry.body.messages.some(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.startsWith("Baseline paragraph"),
        ),
      );
    if (!lastRequest) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(lastRequest, "long draft reached provider");
  const userContent = lastRequest.body.messages
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.content)
    .find((content) => typeof content === "string" && content.includes("Baseline paragraph"));
  assert.equal(
    userContent.replace("x".repeat(25), ""),
    largeText,
    "provider receives all 30k characters",
  );
  checks.push(
    "合成滚轮离开底部，流式增长及完成保持锚点和选区；25次输入有正文变化；显式回到底部；provider收到完整长稿",
  );
  passed = true;
} catch (error) {
  errors.push(error.stack || String(error));
  if (page) await captureSmokeFailure(page, evidence, error);
} finally {
  if (app) {
    const processHandle = app.process();
    await Promise.race([
      app.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (processHandle.exitCode === null && processHandle.signalCode === null)
      processHandle.kill("SIGKILL");
  }
  try {
    for (const id of await readdir(join(state, "registry/services")).catch(() => [])) {
      const record = await readFile(join(state, "registry/services", id, "service.json"), "utf8")
        .then(JSON.parse)
        .catch(() => null);
      if (!record) continue;
      assert.ok(record.dataDir.startsWith(join(state, "core") + "/"));
      const run = (args) =>
        execute(binary, ["service", ...args, "--instance", id, "--json"], {
          env,
          timeout: 30000,
        }).then(({ stdout }) => JSON.parse(stdout));
      if ((await run(["status"])).state !== "stopped") await run(["stop", "--cancel"]);
      assert.equal((await run(["status"])).state, "stopped");
    }
    checks.push("隔离服务已停止");
  } catch (error) {
    errors.push(`cleanup: ${error.stack || error}`);
    passed = false;
  }
  try {
    const { HostClient } = require("../app/src/core/host-client.cjs");
    const { randomUUID } = require("node:crypto");
    const h = new HostClient();
    await h.connect(join(state, "registry"));
    const result = await h.stop(randomUUID(), h.generation, "cancel");
    await writeFile(join(evidence, "host-stop.json"), JSON.stringify(result, null, 2));
    if (result.state !== "completed") {
      passed = false;
      errors.push("host stop not completed");
    }
    h.close();
  } catch (e) {
    if (e.code !== "ENOENT") {
      errors.push(`host stop: ${e.message}`);
      passed = false;
    }
  }
  if (fixture) await fixture.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  const binaryAfter = hash(await readFile(binary));
  if (binaryAfter !== binaryHash) {
    passed = false;
    errors.push("Core binary changed during run");
  }
  const rendererReceipt = await readFile(join(gui, "renderer/dist/verification-build.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  await writeFile(
    join(evidence, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        binary,
        binaryHash,
        binaryAfter,
        rendererReceipt,
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: gui, encoding: "utf8" }).trim(),
        sourceDiffSHA256: hash(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: gui })),
        fixtureFiles: Object.fromEntries(
          await Promise.all(
            [
              "conversation-dual-product-areal.mjs",
              "conversation-dual-product-rich-areal.mjs",
              "send-admission-smoke.mjs",
              "support/conversation-baseline.mjs",
              "support/conversation-baseline-provider.mjs",
            ].map(async (name) => [name, hash(await readFile(join(gui, "scripts", name)))]),
          ),
        ),
        boundary:
          "源码 Electron、隔离 Core 和本地确定性 SSE；原生目录选择和下载保存路径注入；无真实供应商和安装包",
      },
      null,
      2,
    ),
  );
}
console.log(JSON.stringify({ passed, evidence, checks, errors }));
process.exit(passed ? 0 : 1);
