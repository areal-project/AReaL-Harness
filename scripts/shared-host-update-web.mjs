import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";

const argument = process.argv[2];
assert(
  argument && isAbsolute(argument) && process.argv.length === 3,
  "absolute case root required",
);
const root = await realpath(argument);
const result = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
assert.equal(result.mode, "web-pending");
assert.equal(result.root, root);
const require = createRequire(resolve("clients/gui/app/package.json"));
const { chromium } = require("playwright-core");
const profile = join(root, "web-browser-profile");
await mkdir(profile);
const browserId = randomUUID();
let context,
  page,
  browserPid,
  navigationCount = 0,
  webAppSha256,
  current;
const tokens = new Set();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const inside = async (path) => {
  const actual = await realpath(path);
  const part = relative(root, actual);
  assert(part && !part.startsWith("../") && !isAbsolute(part), "service path outside case");
  return actual;
};
const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
};
const proof = async (stage, values) => {
  const path = join(root, `web-${stage.name}-observed.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify(
      {
        stageId: stage.stageId,
        projectId: stage.projectId,
        hostId: stage.hostId,
        generation: stage.generation,
        requestId: stage.requestId,
        browserId,
        browserPid,
        profile,
        navigationCount,
        ...values,
      },
      null,
      2,
    ) + "\n",
  );
  await rename(temporary, path);
};
const validate = async (stage) => {
  assert(["baseline", "pending", "updated", "closed"].includes(stage.name));
  for (const key of ["stageId", "projectId", "hostId", "generation", "requestId", "expectedText"])
    assert.equal(typeof stage[key], "string");
  await inside(stage.service.dataDir);
  await inside(stage.service.authFile);
  const url = new URL(stage.service.webUrl);
  assert.equal(url.protocol, "http:");
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.equal(url.pathname, "/ui");
  return url.href;
};
const login = async (stage, url) => {
  webAppSha256 = undefined;
  await page.goto(url);
  const token = JSON.parse(await readFile(stage.service.authFile, "utf8")).principals[0].token;
  assert.equal(typeof token, "string");
  tokens.add(token);
  await page.locator("#access-token").fill(token);
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.locator("#access-token").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#access-token").inputValue(), "");
};
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n");
  const matches = rows.filter(
    (line) => line.includes(`--user-data-dir=${profile}`) && !line.includes("--type="),
  );
  assert.equal(matches.length, 1, "isolated browser process identity");
  browserPid = Number(matches[0].trim().split(/\s+/)[0]);
  page = context.pages()[0] ?? (await context.newPage());
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigationCount++;
  });
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname !== "/ui/app.js" || !response.ok()) return;
    try {
      webAppSha256 = createHash("sha256")
        .update(await response.body())
        .digest("hex");
    } catch {}
  });
  const seen = new Set();
  while (true) {
    const run = await readJson(join(root, "result.json"));
    if (run?.failure || run?.passed === false) throw new Error("case failed");
    const stage = await readJson(join(root, "web-stage.json"));
    if (!stage || seen.has(stage.stageId)) {
      await delay(100);
      continue;
    }
    current = stage;
    seen.add(stage.stageId);
    const url = await validate(stage);
    if (stage.name === "closed") {
      await context.close();
      context = null;
      const process = spawnSync("/bin/ps", ["-p", String(browserPid), "-o", "pid="], {
        encoding: "utf8",
      });
      assert.equal(process.status, 1, "isolated browser exited");
      await proof(stage, { passed: true, visibleText: "browser closed", browserClosed: true });
      break;
    }
    if (stage.name === "baseline" || stage.name === "updated") await login(stage, url);
    await page.waitForFunction(
      (expected) => document.querySelector("#connection")?.textContent === expected,
      stage.expectedText,
      { timeout: 30000 },
    );
    await page.waitForFunction(() => document.querySelector("#access-token").value === "");
    const visibleText = await page.locator("#connection").innerText();
    const png = join(root, `web-${stage.name}.png`),
      aria = join(root, `web-${stage.name}.aria.txt`);
    await page.screenshot({ path: png, fullPage: true });
    await writeFile(aria, await page.locator("body").ariaSnapshot());
    assert(webAppSha256, "served app.js response unavailable");
    await proof(stage, { passed: true, visibleText, png, aria, webAppSha256 });
    current = null;
  }
} catch (error) {
  if (current) {
    const png = join(root, `web-${current.name}-failure.png`);
    const aria = join(root, `web-${current.name}-failure.aria.txt`);
    if (page && !page.isClosed()) {
      const empty = await page
        .locator("#access-token")
        .inputValue()
        .then((value) => value === "")
        .catch(() => false);
      if (empty) {
        await page.screenshot({ path: png, fullPage: true }).catch(() => {});
        await page
          .locator("body")
          .ariaSnapshot()
          .then((value) => writeFile(aria, value))
          .catch(() => {});
      }
    }
    let message = error.message;
    for (const token of tokens) message = message.replaceAll(token, "[redacted]");
    await proof(current, {
      passed: false,
      visibleText: "",
      png,
      aria,
      webAppSha256,
      error: message,
    });
  }
  process.exitCode = 1;
} finally {
  await context?.close();
  const process =
    browserPid &&
    spawnSync("/bin/ps", ["-p", String(browserPid), "-o", "pid="], { encoding: "utf8" });
  await writeFile(
    join(root, "web-browser-cleanup.json"),
    JSON.stringify(
      { browserId, browserPid, profile, browserClosed: !!process && process.status === 1 },
      null,
      2,
    ) + "\n",
  );
}
