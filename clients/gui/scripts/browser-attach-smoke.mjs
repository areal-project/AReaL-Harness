import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { closeSmokeApplication, stopAndAssertFixtureHost } from "./application-cleanup.mjs";
import { captureSmokeFailure } from "./smoke-navigation.mjs";
import { createScene, coreBin, gui, sendReady } from "./support/journey-fixture.mjs";
import { readCoreThread } from "./support/core-observation.mjs";
import { makeTempDir } from "./support/temp.mjs";

async function readSettledThread(core, count) {
  const deadline = performance.now() + 20000;
  do {
    const thread = await readCoreThread(core);
    assert(thread.turns.length <= count, "Unexpected extra turn");
    const turn = thread.turns[count - 1];
    if (turn?.status === "completed") return thread;
    if (turn) assert.equal(turn.status, "inProgress");
    await delay(100);
  } while (performance.now() < deadline);
  assert.fail(`Core did not complete turn ${count}`);
}

const ready = "NATIVE_BROWSER_INITIAL_REPLY";
const completed = "NATIVE_BROWSER_TOOL_REPLY";
const toolId = "native-browser-describe";
const evidence = await makeTempDir("areal-browser-attach-");
let requests = 0;
const site = createServer((_request, response) => {
  requests++;
  response.setHeader("Content-Type", "text/html");
  response.end("<title>Browser fixture</title><h1>Embedded preview fixture</h1>");
});
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const { messages = [], tools = [] } = JSON.parse(raw);
  const user = messages.findLastIndex(({ role }) => role === "user");
  const inspect = JSON.stringify(messages[user]?.content).includes("Inspect the current page");
  const hasToolResult = messages.slice(user + 1).some(({ role }) => role === "tool");
  const sse = (delta, finish = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  response.setHeader("Content-Type", "text/event-stream");
  if (inspect && !hasToolResult && tools.some((tool) => tool.function?.name === "browser_v1")) {
    response.write(
      sse({
        tool_calls: [
          {
            index: 0,
            id: toolId,
            type: "function",
            function: {
              name: "browser_v1",
              arguments: JSON.stringify({ operation: "describe", parameters: {} }),
            },
          },
        ],
      }) + sse({}, "tool_calls"),
    );
  } else {
    response.write(sse({ content: hasToolResult ? completed : ready }) + sse({}, "stop"));
  }
  response.end("data: [DONE]\n\n");
});
await Promise.all(
  [site, model].map((server) => new Promise((done) => server.listen(0, "127.0.0.1", done))),
);
const url = `http://127.0.0.1:${site.address().port}/`;
const scene = await createScene("areal-native-browser-");
const result = {
  coreSha256: createHash("sha256")
    .update(await readFile(coreBin))
    .digest("hex"),
  scratch: scene.scratch,
};
let desktop, failure;
try {
  desktop = await scene.launchDesktop("web", model.address().port);
  const { app, page, env } = desktop;
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    const original = dialog.showMessageBox;
    dialog.showMessageBox = async (...args) =>
      args.at(-1)?.title === "允许本地开发站点" ? { response: 1 } : original(...args);
  }, scene.project);
  const categories = page.getByRole("button", { name: "项目分类" });
  if ((await categories.getAttribute("aria-expanded")) === "false") await categories.click();
  await page.getByRole("button", { name: "打开项目", exact: true }).click();
  const open = page.getByRole("menuitem").first();
  if (await open.isVisible()) await open.click();
  await page.getByRole("button", { name: "在项目 demo 中新建对话" }).click({ force: true });
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("radio", { name: "fixture", exact: true }).click();
  const input = page.getByTestId("chat-input").first();
  const send = async (text) => {
    await input.fill(text);
    await sendReady(page);
    await input.press("Enter");
  };
  await send("Create a conversation before opening the browser");
  await page.getByText(ready, { exact: false }).first().waitFor({ timeout: 60000 });
  const workbench = page.getByTestId("areal-workbench");
  const projectId = await workbench.getAttribute("data-project-id");
  const threadId = await workbench.getAttribute("data-thread-id");
  assert(projectId && threadId);
  const core = { binary: coreBin, env, gui, threadId, workspace: scene.project };
  const before = await readSettledThread(core, 1);

  await page.keyboard.press(process.platform === "darwin" ? "Meta+t" : "Control+t");
  await page.locator(".preview-panel").waitFor();
  await app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    BrowserWindow.getAllWindows()[0].focus();
  });
  const navigate = await page.evaluate(
    (target) => window.arealDesktop.preview({ operation: "navigate", ...target }),
    { projectId, threadId, url },
  );
  const pageId = navigate?.browser?.pageId;
  assert(pageId, "Preview returns a browser page identity");
  const nativePageId = () =>
    app.evaluate(
      ({ webContents }, target) =>
        webContents.getAllWebContents().find((contents) => contents.getURL() === target)?.id,
      url,
    );
  const deadline = performance.now() + 20000;
  let webContentsId;
  do {
    webContentsId = await nativePageId();
    if (webContentsId && requests > 0) break;
    await delay(100);
  } while (performance.now() < deadline);
  assert(webContentsId, "Preview loads in an Electron WebContents");
  const originalRequests = requests;
  assert(originalRequests > 0);

  await send("Inspect the current page");
  const allow = page.getByRole("button", { name: "允许一次", exact: true });
  await allow.waitFor({ timeout: 60000 });
  await page.screenshot({ path: join(evidence, "approval.png") });
  await allow.click();
  await page.getByText(completed, { exact: false }).first().waitFor({ timeout: 60000 });
  const after = await readSettledThread(core, 2);
  assert.deepEqual(after.turns[0], before.turns[0]);
  const item = after.turns[1].items.find(
    (entry) => entry.type === "dynamicToolCall" && entry.tool === "browser_v1",
  );
  assert.equal(item?.callId, toolId);
  assert.equal(item?.status, "completed");
  assert.equal(item?.execution?.outcome, "succeeded");
  const description = JSON.parse(item.contentItems.find(({ type }) => type === "inputText").text);
  assert.equal(description.threadId, threadId);
  assert.equal(description.pageId, pageId);
  assert.equal(await nativePageId(), webContentsId);
  assert.equal(requests, originalRequests, "Browser tool execution leaves the loaded page intact");
  result.threadId = threadId;
  result.pageId = pageId;
  result.webContentsId = webContentsId;
  result.toolCallId = item.callId;
  await page.screenshot({ path: join(evidence, "finished.png") });
} catch (error) {
  failure = error;
  if (desktop?.page) await captureSmokeFailure(desktop.page, evidence, error).catch(() => {});
} finally {
  if (desktop) {
    const pid = desktop.app.process().pid;
    try {
      await closeSmokeApplication(desktop.app);
      result.electronExit = { pid, code: desktop.app.process().exitCode };
    } catch (error) {
      result.electronCleanupError = error.message;
      failure ??= error;
    }
    try {
      await stopAndAssertFixtureHost(coreBin, desktop.env, evidence, { pid });
    } catch (error) {
      result.hostCleanupError = error.message;
      failure ??= error;
    }
  }
  await Promise.all(
    [site, model].map((server) => {
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    }),
  );
  result.failure = failure?.message ?? null;
  await writeFile(join(evidence, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ evidence, passed: !failure }));
}
if (failure) throw failure;
