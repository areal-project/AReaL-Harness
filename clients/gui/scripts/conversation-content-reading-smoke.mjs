import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { makeTempDir } from "./support/temp.mjs";
import { applicationFixture } from "./application-fixture.mjs";
import {
  captureSmokeFailure,
  createProjectConversation,
  resizeConversation,
} from "./smoke-navigation.mjs";

const gui = resolve(import.meta.dirname, "..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { ServiceConnection } = require("../app/src/core/service-client.cjs");
const { DesktopLifecycle } = require("../app/src/core/lifecycle.cjs");
const execute = promisify(execFile);
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../.local/dev-bin/areal");
const state = await makeTempDir("acr-");
const evidence = process.env.AREAL_CONTENT_READING_EVIDENCE || state;
await mkdir(evidence, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const binaryHash = hash(await readFile(binary));
const checks = [],
  errors = [],
  requests = [];
const table = [
  "| 名称 | 链接 | 代码 | 第四列 | 第五列 | 第六列 | 第七列 | 第八列 | 第九列 | 第十列 |",
  "| :--- | :---: | ---: | --- | --- | --- | --- | --- | --- | --- |",
  ...Array.from(
    { length: 30 },
    (_, i) =>
      `| 第${i + 1}项 | [示例](https://example.com) | \`a \\| b\` | ${Array(7).fill("宽内容测试数据").join(" | ")} |`,
  ),
].join("\n");
const short = "flowchart LR\n A[开始] --> B[完成]";
const wide = `flowchart LR\n${Array.from({ length: 18 }, (_, i) => `N${i}[宽图节点 ${i}]`).join(" --> ")}`;
const long = `flowchart TD\n${Array.from({ length: 18 }, (_, i) => `L${i}[长图节点 ${i}]`).join(" --> ")}`;
const initialText = "短图\n\n```mermaid\n" + short + "\n```\n\n宽图\n\n```mermaid\n";
const remainingText = [
  wide + "\n```",
  "长图\n\n```mermaid\n" + long + "\n```",
  "错误图\n\n```mermaid\nthis is not a diagram\n```",
  "表格\n\n" + table,
  "阅读结束标记",
].join("\n\n");
let releaseStream;
const event = (text) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
const model = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const title = String(body.messages?.[0]?.content).startsWith(
    "Generate a concise semantic session title",
  );
  res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
  const finish = (text) =>
    res.end(
      `${event(text)}data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  if (title) return finish("内容阅读");
  res.write(event(initialText));
  releaseStream = () => {
    releaseStream = undefined;
    finish(remainingText);
  };
});
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
  await page.getByTestId("chat-input").fill("展示图表和表格");
  await page.getByTestId("chat-send-button").click();
  const pendingDiagramButtons = page.getByRole("button", { name: "放大查看", exact: true });
  await pendingDiagramButtons.first().waitFor({ timeout: 120000 });
  assert.equal(await pendingDiagramButtons.count(), 1, "已闭合图形可放大，未闭合图形不提供入口");
  await pendingDiagramButtons.first().click();
  await page.getByRole("dialog").getByRole("region", { name: "图形画布" }).waitFor();
  assert.ok(releaseStream, "模型仍在流式输出");
  releaseStream();
  await page.getByText("阅读结束标记", { exact: true }).waitFor({ timeout: 120000 });
  assert.equal(await page.getByRole("dialog").isVisible(), true, "流式结束后图形查看器保持打开");
  await page.keyboard.press("Escape");
  assert.equal(
    await pendingDiagramButtons.first().evaluate((node) => node === document.activeElement),
    true,
    "流结束后焦点返回首个图形入口",
  );
  checks.push("流式期间已闭合图形可查看，未闭合围栏不提供入口，回复完成后查看器保持打开");
  await page.screenshot({ path: join(evidence, "conversation.png"), scale: "css" });
  checks.push("真实 Electron 通过隔离 Core 和本地 SSE 模型接收图表与表格");
  const diagramButtons = page.getByRole("button", { name: "放大查看", exact: true });
  assert.ok((await diagramButtons.count()) >= 4, "图表和表格提供可见的放大查看入口");
  for (const index of [0, 1, 2]) {
    const trigger = diagramButtons.nth(index);
    await trigger.scrollIntoViewIfNeeded();
    const before = await trigger.boundingBox();
    await trigger.click();
    const dialog = page.getByRole("dialog");
    const canvas = dialog.getByRole("region", { name: "图形画布" });
    await canvas.waitFor();
    await dialog.getByRole("button", { name: "原始尺寸" }).click();
    assert.equal(await dialog.locator("output").textContent(), "100%");
    await dialog.getByRole("button", { name: "适应窗口" }).click();
    const fit = await dialog.locator("output").textContent();
    await dialog.getByRole("button", { name: "放大", exact: true }).click();
    assert.notEqual(await dialog.locator("output").textContent(), fit);
    await canvas.focus();
    await page.keyboard.press("1");
    assert.equal(await dialog.locator("output").textContent(), "100%");
    if (index === 1 || index === 2) {
      const bounds = await canvas.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 - 180, bounds.y + bounds.height / 2 - 180, {
        steps: 8,
      });
      await page.mouse.up();
      const offset = await canvas.evaluate((element) => ({
        x: element.scrollLeft,
        y: element.scrollTop,
      }));
      assert.ok(index === 1 ? offset.x > 0 : offset.y > 0, "拖动移动超出视口的图形");
    }
    await page.screenshot({ path: join(evidence, `diagram-${index}.png`), scale: "css" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
    const after = await trigger.boundingBox();
    assert.ok(Math.abs(after.y - before.y) < 3, "关闭后保留消息阅读位置");
  }
  checks.push("短、宽、长图支持原始尺寸、适应窗口、缩放、拖动及 Escape 返回");
  await diagramButtons.nth(3).click();
  const errorDialog = page.getByRole("dialog");
  await errorDialog.getByText("图形暂无法预览，可切换源码查看。", { exact: true }).waitFor();
  await errorDialog.getByRole("button", { name: "重新绘制" }).click();
  await errorDialog.getByText("图形暂无法预览，可切换源码查看。", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "diagram-error.png"), scale: "css" });
  await page.keyboard.press("Escape");
  checks.push("错误图显示失败状态并支持重试");
  await resizeConversation(app, page, 700, 720);
  const tableTrigger = diagramButtons.last();
  await tableTrigger.click();
  const tableDialog = page.getByRole("dialog");
  const tableRegion = tableDialog.getByRole("region", { name: "表格预览" });
  await tableRegion.waitFor();
  await tableDialog.getByRole("button", { name: "复制 Markdown" }).click();
  await page.getByText("已复制 Markdown 表格", { exact: true }).waitFor();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), table);
  const tableSize = await tableRegion.evaluate((node) => ({
    width: node.clientWidth,
    scrollWidth: node.scrollWidth,
    height: node.clientHeight,
    scrollHeight: node.scrollHeight,
  }));
  assert.ok(
    tableSize.scrollWidth > tableSize.width && tableSize.scrollHeight > tableSize.height,
    "表格在预览中横向和纵向均溢出",
  );
  await tableRegion.focus();
  await page.keyboard.press("ArrowRight");
  await tableRegion.evaluate(
    (node) =>
      new Promise((resolve, reject) => {
        const end = Date.now() + 5000;
        const check = () => {
          if (node.scrollLeft > 0) return resolve();
          if (Date.now() >= end) return reject(new Error("表格键盘横滚超时"));
          requestAnimationFrame(check);
        };
        check();
      }),
  );
  assert.ok((await tableRegion.evaluate((node) => node.scrollLeft)) > 0, "键盘横向滚动表格");
  const header = tableDialog.locator("th").first();
  const headerBefore = await header.boundingBox();
  await tableRegion.evaluate((node) => {
    node.scrollTop = 400;
  });
  const headerAfter = await header.boundingBox();
  assert.ok(Math.abs(headerAfter.y - headerBefore.y) < 3, "纵向滚动时表头保持可见");
  await app.evaluate(
    ({ BrowserWindow }, path) => {
      globalThis.contentReadingDownload = new Promise((resolve) => {
        BrowserWindow.getAllWindows()[0].webContents.session.once(
          "will-download",
          (_event, item) => {
            item.setSavePath(path);
            item.once("done", (_done, status) => resolve(status));
          },
        );
      });
    },
    join(evidence, "table.csv"),
  );
  await tableDialog.getByRole("button", { name: "下载 CSV" }).click();
  const downloadStatus = await app.evaluate(() =>
    Promise.race([
      globalThis.contentReadingDownload,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 10000)),
    ]),
  );
  assert.equal(downloadStatus, "completed", "Electron 下载完成");
  assert.match(await readFile(join(evidence, "table.csv"), "utf8"), /第1项/);
  await page.screenshot({ path: join(evidence, "table-dialog.png"), scale: "css" });
  await page.keyboard.press("Escape");
  await tableDialog.waitFor({ state: "hidden" });
  checks.push("表格预览支持原始 Markdown 复制、键盘横滚和 CSV 下载");
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains("dark")),
    true,
  );
  await diagramButtons.first().click();
  await page.getByRole("dialog").getByRole("region", { name: "图形画布" }).waitFor();
  await page.screenshot({ path: join(evidence, "narrow.png"), scale: "css" });
  await page.keyboard.press("Escape");
  checks.push("窄窗口暗色主题下图形查看器可打开");
  passed = true;
} catch (error) {
  errors.push(error.stack || String(error));
  if (page) await captureSmokeFailure(page, evidence, error);
} finally {
  releaseStream?.();
  const metadata = await readFile(join(state, "core/service.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (app) {
    const processHandle = app.process();
    await Promise.race([
      app.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (processHandle.exitCode === null && processHandle.signalCode === null)
      processHandle.kill("SIGKILL");
  }
  const connection = new ServiceConnection();
  try {
    if (metadata) {
      try {
        process.kill(metadata.pid, 0);
        await Promise.race([
          connection.connect(metadata),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Desktop connection timeout")), 5000),
          ),
        ]);
        await connection.request("hello", {
          protocol: metadata.protocol,
          identity: metadata.identity,
        });
        await Promise.race([
          new DesktopLifecycle({
            connection,
            metadata,
            home: join(state, "core"),
            notify: async () => ({ response: 1 }),
          }).stop({ mode: "cancel" }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Desktop stop timeout")), 10000),
          ),
        ]);
      } catch (error) {
        try {
          process.kill(metadata.pid, 0);
          errors.push(`desktop cleanup: ${error.message}`);
          passed = false;
        } catch (status) {
          if (status.code !== "ESRCH") {
            errors.push(`desktop cleanup: ${status.message}`);
            passed = false;
          }
        }
      }
    }
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
  connection.close();
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
        boundary:
          "源码 Electron、隔离 Core 和本地确定性 SSE；原生目录选择和下载保存路径注入；无真实供应商和安装包",
      },
      null,
      2,
    ),
  );
  await writeFile(join(evidence, "model-requests.json"), JSON.stringify(requests, null, 2));
}
console.log(JSON.stringify({ passed, evidence, checks, errors }));
process.exit(passed ? 0 : 1);
