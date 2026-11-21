import { bundleAnalysis } from "./bundle-analysis.mjs";
import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { build } from "vite-plus";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");
const scratch = await makeTempDir("areal-history-navigation-");
const root = resolve(gui, "../..");
const dist = join(scratch, "renderer");
await build({
  configFile: false,
  plugins: [bundleAnalysis()],
  logLevel: "warn",
  build: {
    outDir: join(scratch, "bridge"),
    lib: {
      entry: join(gui, "renderer/test-fixtures/history-navigation.ts"),
      formats: ["iife"],
      name: "historyNavigationFixture",
      fileName: () => "fixture.js",
    },
  },
});
const buildIdentity = JSON.parse(
  execFileSync(
    "python3",
    [
      join(root, "scripts/verification.py"),
      "--root",
      root,
      "snapshot-renderer",
      "--source-dir",
      process.env.AREAL_RENDERER_DIST || join(gui, "renderer/dist"),
      "--output-dir",
      dist,
    ],
    { encoding: "utf8" },
  ),
);
const bridgeIdentity = JSON.parse(
  await readFile(join(scratch, "bridge/verification-build.json"), "utf8"),
);
assert.equal(
  bridgeIdentity.inputHash,
  buildIdentity.inputHash,
  "Bridge and Renderer must share build inputs",
);
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://local").pathname);
    const path = resolve(dist, pathname === "/" ? "index.html" : `.${pathname}`);
    if (!path.startsWith(dist + sep)) throw new Error("Invalid asset path");
    response.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
      }[extname(path)] || "application/octet-stream",
    );
    response.end(await readFile(path));
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser,
  passed = false;
const checks = [],
  errors = [],
  failures = [];
const check = (condition, message) => {
  try {
    assert.ok(condition, message);
    checks.push(message);
  } catch (error) {
    failures.push(error.message);
  }
};
try {
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  page.on("pageerror", (error) => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.addInitScript({ path: join(scratch, "bridge/fixture.js") });
  await page.goto(origin);
  await page.getByTestId("chat-input").waitFor();
  const history = page.getByTestId("task-item-synthetic-history").first();
  await history.click();
  await page.getByText("RESTORED_HISTORY_SENTINEL", { exact: true }).waitFor();
  check(true, "Cold startup from a draft opens an existing history by mouse.");
  await page.screenshot({ path: join(scratch, "01-click-history.png") });
  await page.getByRole("button", { name: "新会话", exact: true }).click();
  await page.getByTestId("chat-input").waitFor();
  await page.evaluate(() => window.creationPending("areal/thread/start", "unrelated-create"));
  await history.focus();
  await page.keyboard.press("Enter");
  await page.getByText("RESTORED_HISTORY_SENTINEL", { exact: true }).waitFor({ timeout: 5000 });
  check(
    true,
    "Existing history remains keyboard-accessible while an unrelated creation outcome is unknown.",
  );
  check(
    (await page.evaluate(() => window.calls)).filter((call) =>
      ["send", "create", "steer", "enqueue"].includes(call.name),
    ).length === 0,
    "History navigation never submits or replays work.",
  );
  check(
    (await page.evaluate(() => window.fixture())).projects[0].pending.some(
      (item) => item.params.requestId === "unrelated-create",
    ),
    "Read navigation preserves the original unresolved creation.",
  );
  await page.screenshot({ path: join(scratch, "02-pending-history.png") });
  await page.getByTestId("task-item-second-history").first().click();
  await page.getByText("SECOND_HISTORY_SENTINEL", { exact: true }).waitFor({ timeout: 5000 });
  check(
    (await page.getByTestId("areal-workbench").getAttribute("data-project-id")) ===
      "second-fixture",
    "A cached history in another cold project connects its own owner and stays selected.",
  );
  check(
    (await page.evaluate(() => window.calls)).filter((call) =>
      ["send", "create", "steer", "enqueue"].includes(call.name),
    ).length === 0,
    "Cross-project reads do not replay unknown writes.",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  passed = true;
} catch (error) {
  failures.push(error.stack ?? String(error));
  throw error;
} finally {
  const cleanup = await Promise.allSettled([
    browser?.close(),
    new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  ]);
  for (const result of cleanup)
    if (result.status === "rejected") failures.push(String(result.reason));
  passed = passed && failures.length === 0;
  await writeFile(
    join(scratch, "result.json"),
    JSON.stringify({ passed, buildIdentity, checks, errors, failures }, null, 2),
  );
  console.log(JSON.stringify({ passed, scratch, checks, errors, failures }));
  if (!passed) process.exitCode = 1;
}
