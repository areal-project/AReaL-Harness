import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
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
  await page.getByTestId("chat-input").fill("BASELINE:RICH");
  await page.getByTestId("chat-send-button").click();
  const triggers = page.getByRole("button", { name: "放大查看", exact: true });
  await triggers.first().waitFor({ timeout: 120000 });
  await triggers.first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("region", { name: "图形画布" }).waitFor();
  await page.screenshot({ path: join(evidence, "01-diagram-streaming.png"), scale: "css" });
  await writeFile(gatePath, "release\n");
  const deadline = Date.now() + 30000;
  let completed = false;
  while (Date.now() < deadline && !completed) {
    const entries = (await readFile(join(evidence, "provider.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    completed = entries.some((entry) => entry.kind === "complete" && entry.scenario === "rich");
    if (!completed) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(completed, "provider confirms rich response completion");
  await page.locator(".composer-stop-action").waitFor({ state: "detached", timeout: 30000 });
  assert.equal(await dialog.isVisible(), true, "diagram stays open when stream finishes");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await triggers.first().evaluate((node) => node === document.activeElement), true);
  await triggers.last().click();
  const table = page.getByRole("dialog");
  const region = table.getByRole("region", { name: "表格预览" });
  await region.waitFor();
  await table.getByRole("button", { name: "复制 Markdown" }).click();
  await page.getByText("已复制 Markdown 表格", { exact: true }).waitFor();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  const expected = baselineContent.richResponse.slice(
    baselineContent.richResponse.indexOf("| ID |"),
    baselineContent.richResponse.indexOf("\n\n```typescript"),
  );
  assert.equal(copied, expected, "copied Markdown exactly matches shared table");
  await writeFile(join(evidence, "copied-table.md"), copied);
  await page.screenshot({ path: join(evidence, "02-table-preview.png"), scale: "css" });
  checks.push("共享 Mermaid 在流式期间打开且结束后保持；表格复制 Markdown 与共享素材逐字一致");
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
    const { HostClient } = require("@areal/client/node");
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
