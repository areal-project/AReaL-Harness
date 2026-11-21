import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createProjectConversation,
  selectConversation,
  captureSmokeFailure,
} from "./smoke-navigation.mjs";
import { readCoreThread } from "./support/core-observation.mjs";
import { installHostTransportBarrier } from "./support/host-transport-barrier.mjs";
import {
  closeSmokeApplication,
  readFixtureHost,
  settleFixtureHostAfterQuit,
} from "./application-cleanup.mjs";
import { applicationFixture } from "./application-fixture.mjs";
import { respondToSessionName } from "./model-fixture.mjs";

// 主流程与失败方式：同页截图、多条确认、跨聊天隔离、上传拒绝保留、显式重试及历史回取。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const scratch = await makeTempDir("areal-browser-annotations-");
const workspace = join(scratch, "workspace"),
  user = join(scratch, "user");
await mkdir(workspace);
await mkdir(join(user, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
let posts = 0;
const site = createServer((request, response) => {
  if (request.method === "POST") posts++;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(
    '<!doctype html><style>body{background:#111827;color:#e5e7eb;padding:35px;font:20px system-ui}h1{font-size:30px}button{font:20px system-ui;background:#2563eb;color:white;padding:12px;border:0;border-radius:8px}</style><h1 id="heading">ANNOTATION_HEADING</h1><button id="target">ANNOTATION_BUTTON</button><p>Same live page, synthetic data.</p>',
  );
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${site.address().port}/`;
const requests = [];
const messageText = (content) =>
  typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
const annotatedUser = (body) =>
  body.messages.findLast(
    (message) => message.role === "user" && messageText(message.content).startsWith("保留我的正文"),
  );
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  if (respondToSessionName(body, response)) return;
  const prediction = body.messages.some(
    (message) =>
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.startsWith("Predict the next user prompt from the conversation data."),
  );
  if (!prediction) requests.push(body);
  const reply = prediction ? "" : "ANNOTATIONS_RECEIVED";
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
  join(user, ".areal/config.toml"),
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      {
        id: "fixture",
        revision: "v1",
        displayName: "Fixture",
        instructions: "Read the user feedback.",
      },
    ],
  }),
);
const packagedExecutable = process.env.AREAL_GUI_EXECUTABLE;
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  HOME: user,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: user,
  AREAL_HARNESS_HOME: join(scratch, "harness"),
  AREAL_CORE_CONFIG: join(user, ".areal/config.toml"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || join(root, "target/debug/areal"),
  NO_PROXY: [env.NO_PROXY, "127.0.0.1,localhost,::1"].filter(Boolean).join(","),
  no_proxy: [env.no_proxy, "127.0.0.1,localhost,::1"].filter(Boolean).join(","),
});
if (packagedExecutable) delete env.AREAL_CORE_BIN;
const testedCore = packagedExecutable
  ? join(dirname(dirname(packagedExecutable)), "Resources/areal-core/bin/areal")
  : env.AREAL_CORE_BIN;
let fixture,
  app,
  page,
  passed = false;
const errors = [],
  checks = [],
  facts = {};
const until = async (read, label) => {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(`Timeout: ${label}`);
};
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const settlePopup = async (name = "待发送的标注") => {
  await until(
    () =>
      page
        .getByRole("dialog", { name, exact: true })
        .evaluate(
          (popup) =>
            !popup.hasAttribute("data-starting-style") && getComputedStyle(popup).opacity === "1",
        ),
    "annotation popup transition",
  );
  await page
    .locator(".browser-annotation-attachment-card img")
    .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
};
const observeThread = (threadId) =>
  readCoreThread({ binary: testedCore, env, gui, threadId, workspace });
try {
  if (!packagedExecutable) fixture = await applicationFixture(gui, join(scratch, "app"));
  app = await electron.launch({
    executablePath: packagedExecutable || require("electron"),
    args: fixture ? [fixture.path] : [],
    env,
    timeout: 120000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await state()).connection?.state === "ready", "service ready");
  await app.evaluate(
    ({ app, dialog, BrowserWindow }, { workspace }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
      const w = BrowserWindow.getAllWindows()[0];
      w.setSize(1440, 1000);
      app.focus({ steal: true });
      w.focus();
    },
    { workspace, origin: new URL(url).origin },
  );
  await page.locator(".composer-project").click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  const project = await until(
    async () => (await state()).projects.find((p) => p.root === workspace),
    "Workspace registered",
  );
  const workbench = page.getByTestId("areal-workbench");
  await until(
    async () => (await workbench.getAttribute("data-project-id")) === project.id,
    "Workspace selected",
  );
  const seed = async (text, previousThreadId) => {
    await page.getByRole("button", { name: "选择模型", exact: true }).click();
    await page.getByRole("tab", { name: "fixture", exact: true }).click();
    await page.locator('[data-model-value="fixture/fixture"]').getByRole("radio").click();
    await page.keyboard.press("Escape");
    await page.getByTestId("chat-input").fill(text);
    await page.getByTestId("chat-send-button").click();
    const threadId = await until(async () => {
      const id = await workbench.getAttribute("data-thread-id");
      return id && id !== previousThreadId && id;
    }, "Native conversation created");
    await until(async () => {
      const turn = (await observeThread(threadId)).turns.at(-1);
      return turn?.status === "completed";
    }, "Core seed Turn completed");
    return { threadId };
  };
  const first = await seed("Annotation fixture conversation");
  await createProjectConversation(page, "workspace");
  const other = await seed("Other fixture conversation", first.threadId);
  const seedRequestCount = requests.length;
  assert.equal(seedRequestCount, 2, "The fixture creates two distinct seed Turns");
  const identity = { projectId: project.id, threadId: first.threadId };
  await selectConversation(page, first.threadId);
  await app.evaluate(({ app, BrowserWindow }) => {
    app.setActivationPolicy("regular");
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.moveTop();
    app.focus({ steal: true });
    window.focus();
  });
  await until(
    () =>
      app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return window.isVisible() && !window.isMinimized();
      }),
    "visible owned annotation window",
  );
  await page.keyboard.press("Meta+t");
  await page.locator(".preview-panel").waitFor();
  await page.evaluate((q) => window.arealDesktop.preview(q), {
    ...identity,
    operation: "navigate",
    url,
  });
  const nativeId = await until(
    () =>
      app.evaluate(
        ({ webContents }, url) =>
          webContents.getAllWebContents().find((c) => c.getURL() === url)?.id,
        url,
      ),
    "native page",
  );
  facts.nativeId = nativeId;
  const expected = await app.evaluate(
    ({ webContents }, id) =>
      webContents.fromId(id).executeJavaScriptInIsolatedWorld(1001, [
        {
          code: `JSON.stringify(['heading','target'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth,height:innerHeight}}))`,
        },
      ]),
    nativeId,
  );
  const targets = JSON.parse(expected);
  // 记录界面实际预览的 Blob，避免 areal-ui 的连接策略影响测试取证。
  await page.evaluate(() => {
    const original = URL.createObjectURL.bind(URL);
    globalThis.__annotationBlobs = new Map();
    URL.createObjectURL = (blob) => {
      const url = original(blob);
      globalThis.__annotationBlobs.set(url, blob);
      return url;
    };
  });
  // 截图后的 DOM 替换不能把旧像素标成新元素；只修改隔离本地 fixture。
  const staleCapture = await page.evaluate(
    (q) => window.arealDesktop.preview({ ...q, operation: "captureRegion" }),
    {
      ...identity,
      pageId: (
        await page.evaluate(
          (q) => window.arealDesktop.preview({ ...q, operation: "state" }),
          identity,
        )
      ).browser.pageId,
    },
  );
  await app.evaluate(
    ({ webContents }, id) =>
      webContents
        .fromId(id)
        .executeJavaScript(
          `document.getElementById('heading').outerHTML='<h1 id="heading">REPLACED_AFTER_FREEZE</h1>'`,
        ),
    nativeId,
  );
  const staleResult = await page.evaluate(
    async (q) => {
      try {
        return { selected: await window.arealDesktop.preview(q) };
      } catch (e) {
        return { error: e.message };
      }
    },
    {
      ...identity,
      pageId: staleCapture.pageId,
      operation: "selectElement",
      captureId: staleCapture.captureId,
      x: Math.floor((targets[0].x * staleCapture.viewport.bitmapWidth) / targets[0].width),
      y: Math.floor((targets[0].y * staleCapture.viewport.bitmapHeight) / targets[0].height),
    },
  );
  assert.ok(
    staleResult.error || staleResult.selected?.available === false,
    "DOM replacement after freeze must not attach a replacement element identity to old pixels",
  );
  await page.evaluate((q) => window.arealDesktop.preview(q), {
    ...identity,
    pageId: staleCapture.pageId,
    operation: "endRegion",
    captureId: staleCapture.captureId,
  });
  await app.evaluate(
    ({ webContents }, id) =>
      webContents
        .fromId(id)
        .executeJavaScript(
          `document.getElementById('heading').outerHTML='<h1 id="heading">ANNOTATION_HEADING</h1>'`,
        ),
    nativeId,
  );
  checks.push(
    "Post-freeze DOM replacement is rejected before element identity projection; region-only screenshot evidence remains available",
  );
  await page.getByTestId("chat-input").fill("保留我的正文");
  const foldedAnnotationText = "折叠标注第一行\n第二行\n第三行\n第四行\n第五行";
  await page.getByTestId("chat-input").evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  }, foldedAnnotationText);
  await page.getByRole("button", { name: "移除附件 折叠标注第一行", exact: true }).waitFor();
  await page.getByRole("button", { name: "批注", exact: true }).click();
  const region = page.getByRole("region", { name: "冻结截图区域标注" });
  await region.waitFor();
  assert.equal(
    await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getURL(), nativeId),
    url,
  );
  const image = region.locator("img");
  const box = await image.boundingBox();
  assert.ok(box?.width && box.height);
  // 在现有 IPC 边界拒绝一次元素选择，随后通过真实工具栏切换区域模式。
  await app.evaluate(({ ipcMain }, identity) => {
    const handlers = ipcMain._invokeHandlers;
    const original = handlers.get("areal-core:preview");
    handlers.set("areal-core:preview", (event, request) => {
      if (
        request.operation === "selectElement" &&
        request.projectId === identity.projectId &&
        request.threadId === identity.threadId
      ) {
        handlers.set("areal-core:preview", original);
        globalThis.__annotationSelectionFailure = {
          threadId: request.threadId,
          captureId: request.captureId,
        };
        throw new Error("测试：元素选择失败");
      }
      return original(event, request);
    });
  }, identity);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByText("浏览器操作未完成", { exact: true }).waitFor();
  facts.elementFailure = await app.evaluate(() => globalThis.__annotationSelectionFailure);
  assert.equal(facts.elementFailure?.threadId, first.threadId);
  assert.ok(facts.elementFailure.captureId);
  await region.getByRole("button", { name: "框选区域" }).click();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4, { steps: 5 });
  await page.mouse.up();
  const recoveryEditor = region.getByRole("dialog", { name: "编辑当前标注" });
  await recoveryEditor.waitFor();
  await recoveryEditor.getByRole("textbox", { name: "标注意见" }).fill("REGION_RECOVERED");
  await recoveryEditor.getByRole("button", { name: "加入聊天草稿" }).click();
  await page.getByRole("button", { name: "1 条标注", exact: true }).waitFor();
  await region.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "1 条标注", exact: true }).click();
  await settlePopup();
  await page.getByRole("button", { name: "删除标注 1", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "批注", exact: true }).click();
  await region.waitFor();
  await region.getByRole("button", { name: "点选元素" }).click();
  checks.push(
    "Element selection failure recovers through region mode and stages a region annotation",
  );
  const resumedBox = await region.locator("img").boundingBox();
  assert.ok(resumedBox?.width && resumedBox.height);
  for (const [index, target] of targets.entries()) {
    await page.mouse.click(
      resumedBox.x + (target.x / target.width) * resumedBox.width,
      resumedBox.y + (target.y / target.height) * resumedBox.height,
    );
    const editor = region.getByRole("dialog", { name: "编辑当前标注" });
    await editor.waitFor();
    assert.equal(
      await page.getByTestId("chat-send-button").isDisabled(),
      true,
      "unconfirmed annotation blocks send",
    );
    await editor.getByRole("textbox", { name: "标注意见" }).fill(`ANNOTATION_COMMENT_${index + 1}`);
    if (index === 0) {
      await editor
        .getByRole("textbox", { name: "标注意见" })
        .evaluate((input) =>
          input.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
          ),
        );
      assert.equal(await page.getByTestId("browser-annotation-attachments").count(), 0);
      assert.notEqual(
        await editor.evaluate((element) => getComputedStyle(element).backgroundColor),
        "rgba(0, 0, 0, 0)",
        "editor must have a theme surface above the native screenshot",
      );
      await page.screenshot({ path: join(scratch, "inline-editor.png") });
      await page.evaluate(() => window.arealDesktop.theme("data-dense"));
      await app.evaluate(({ nativeTheme }) => nativeTheme.emit("updated"));
      await until(
        () => page.evaluate(() => document.documentElement.classList.contains("dark")),
        "dark annotation surface",
      );
      await page.screenshot({ path: join(scratch, "inline-editor-dark.png") });
    }
    await editor.getByRole("button", { name: "加入聊天草稿" }).click();
    await page.getByRole("button", { name: `${index + 1} 条标注`, exact: true }).waitFor();
    await editor.waitFor({ state: "detached" });
  }
  assert.equal(await page.getByTestId("chat-input").innerText(), "保留我的正文");
  await region.getByRole("button", { name: "完成", exact: true }).click();
  await region.waitFor({ state: "detached" });
  checks.push(
    "Same Native page supplies two element crops; confirmation stages multiple records without overwriting Composer text",
  );
  await selectConversation(page, other.threadId);
  assert.equal(await page.getByTestId("browser-annotation-attachments").count(), 0);
  await selectConversation(page, first.threadId);
  await page.getByRole("button", { name: "2 条标注", exact: true }).waitFor();
  await page.getByRole("button", { name: "2 条标注", exact: true }).click();
  await settlePopup();
  const draftImages = await page
    .locator(".browser-annotation-attachment-card img")
    .evaluateAll(async (images) =>
      Promise.all(
        images.map(async (image) =>
          Array.from(
            new Uint8Array(await globalThis.__annotationBlobs.get(image.src).arrayBuffer()),
          ),
        ),
      ),
    );
  facts.draftImageHashes = draftImages.map((bytes) =>
    createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
  );
  assert.equal(draftImages.length, 2);
  await page.getByRole("textbox", { name: "标注 2 内容" }).fill("");
  assert.equal(await page.getByTestId("chat-send-button").isDisabled(), true);
  await page.getByRole("textbox", { name: "标注 2 内容" }).fill("ANNOTATION_COMMENT_2_EDITED");
  await page.screenshot({ path: join(scratch, "composer-review.png") });
  await page.keyboard.press("Escape");
  checks.push(
    "Thread navigation isolates and restores annotations; each comment is editable beside its crop",
  );
  // 暂停原附件块，在同一 Host 通道释放一份会被拒绝的请求来验证失败前后的草稿。
  await page.evaluate(installHostTransportBarrier);
  await page.evaluate((threadId) => {
    globalThis.__annotationUploadGate = {};
    globalThis.__annotationBarrier = globalThis.createHostTransportBarrier((frame) => {
      const gate = globalThis.__annotationUploadGate;
      if (
        gate.requestId ||
        frame.method !== "attachment.upload" ||
        frame.params?.threadId !== threadId ||
        frame.params.offset !== 0
      )
        return null;
      Object.assign(gate, {
        holdRequest: true,
        data: JSON.stringify({ ...frame, params: { ...frame.params, base64: "" } }),
        onResponse(reply) {
          gate.replyId = reply.id;
          gate.errorCode = reply.error?.code;
        },
      });
      return gate;
    });
  }, first.threadId);
  await page.getByTestId("chat-send-button").click();
  await until(
    () => page.evaluate(() => globalThis.__annotationUploadGate.requestHit),
    "Original attachment upload reached the gate",
  );
  await page.getByText("正在发送消息", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("chat-send-button").isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "2 条标注", exact: true }).count(), 0);
  assert.equal(
    await page
      .locator(".browser-annotation-attachment-card")
      .getByRole("button", { name: /删除标注|移除附件/ })
      .count(),
    0,
    "locked thumbnail cannot expose an active remove control",
  );
  await page.evaluate(() => globalThis.__annotationUploadGate.releaseRequest());
  facts.rejectedUpload = await until(
    () =>
      page.evaluate(() => {
        const { requestHit, replyId, errorCode } = globalThis.__annotationUploadGate;
        return replyId === requestHit && { requestHit, replyId, errorCode };
      }),
    "Host rejects the original attachment block",
  );
  assert.equal(facts.rejectedUpload.errorCode, "INVALID_PARAMS");
  const admissionNotice = page
    .locator(".composer-dock")
    .getByTestId("feedback-notice")
    .getByRole("alert");
  await admissionNotice.waitFor();
  await page.getByRole("button", { name: "2 条标注", exact: true }).waitFor();
  assert.equal(requests.length, seedRequestCount, "rejected upload cannot submit");
  assert.equal((await observeThread(first.threadId)).turns.length, 1);
  await page.getByRole("button", { name: "2 条标注", exact: true }).click();
  await settlePopup();
  assert.equal(
    await page.getByRole("textbox", { name: "标注 2 内容" }).inputValue(),
    "ANNOTATION_COMMENT_2_EDITED",
  );
  await page.keyboard.press("Escape");
  checks.push(
    "Pending upload locks thumbnail removal; known upload refusal retains both annotation files and comments for explicit retry",
  );
  await page.locator("input[type=file]").setInputFiles({
    name: "oversize.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(17 * 1024 * 1024),
  });
  await page.getByTestId("chat-send-button").click();
  await admissionNotice.filter({ hasText: "oversize.bin" }).waitFor();
  await page.getByRole("button", { name: "2 条标注", exact: true }).waitFor();
  assert.equal(requests.length, seedRequestCount, "upload refusal cannot submit the message");
  await page.getByRole("button", { name: "移除附件 oversize.bin", exact: true }).click();
  await page.getByRole("button", { name: "2 条标注", exact: true }).waitFor();
  await page.getByTestId("chat-send-button").click();
  await page
    .getByRole("button", { name: "已发送 2 条标注", exact: true })
    .waitFor({ timeout: 60000 });
  assert.equal(await page.getByTestId("browser-annotation-attachments").count(), 0);
  const history = await until(async () => {
    const thread = await observeThread(first.threadId);
    const turn = thread.turns.at(-1);
    return thread.turns.length === 2 && turn?.status === "completed" ? thread : null;
  }, "accepted Core history");
  facts.history = history;
  const annotationUser = history.turns.at(-1).items.find((item) => item.type === "userMessage");
  const annotationUserText = annotationUser.content.find((part) => part.type === "text").text;
  assert.ok(
    annotationUserText.startsWith(`保留我的正文\n\n${foldedAnnotationText}\n\n`),
    "folded text before image annotations keeps its exact body prefix",
  );
  assert.equal(
    annotationUser.content.filter((part) => part.type !== "text").length,
    2,
    "folded pasted text remains body text without an additional uploaded file",
  );
  const modelBody = await until(
    () => requests.findLast((body) => annotatedUser(body)),
    "annotated human model request",
  );
  const modelUser = annotatedUser(modelBody);
  assert.equal(requests.length, seedRequestCount + 1, "Only explicit retry reaches the model");
  assert.ok(
    Array.isArray(modelUser.content),
    "Annotated human model message retains structured text and image parts",
  );
  const serialized = JSON.stringify(modelUser);
  assert.match(serialized, /ANNOTATION_COMMENT_1/);
  assert.match(serialized, /ANNOTATION_COMMENT_2_EDITED/);
  assert.match(serialized, /折叠标注第一行/);
  const images = modelUser.content.filter((part) => part.type === "image_url");
  assert.equal(images.length, 2, "model receives both actual PNG crops");
  facts.images = images.map((p) => ({
    sha256: createHash("sha256")
      .update(Buffer.from(p.image_url.url.split(",")[1], "base64"))
      .digest("hex"),
  }));
  assert.deepEqual(
    facts.images.map((image) => image.sha256),
    facts.draftImageHashes,
    "Core model receives the exact PNG bytes reviewed in Composer",
  );
  checks.push(
    "folded Text before annotated PNGs preserves exact body, original File identity and image URL pairing",
  );
  assert.equal(posts, 0, "annotation never clicks the page button");
  await page.getByRole("button", { name: "已发送 2 条标注", exact: true }).click();
  await page.getByText("ANNOTATION_COMMENT_2_EDITED", { exact: true }).waitFor();
  await settlePopup("已发送的标注");
  await page.screenshot({ path: join(scratch, "sent-annotations.png") });
  checks.push(
    "Upload refusal preserves notes; explicit retry sends two images plus comments through Core and clears only accepted draft",
  );
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByTestId("areal-workbench").waitFor();
  await selectConversation(page, first.threadId);
  await page.getByRole("button", { name: "已发送 2 条标注", exact: true }).waitFor();
  checks.push("Sent annotation cards rebuild from Core history after Renderer reload");
  assert.deepEqual(errors, []);
  passed = true;
} catch (e) {
  errors.push(e.stack ?? String(e));
  if (page) await captureSmokeFailure(page, scratch, e);
  throw e;
} finally {
  let originalHost;
  try {
    originalHost = await readFixtureHost(env);
  } catch (error) {
    errors.push("Host identity: " + error.message);
    passed = false;
  }
  const guiPid = app?.process().pid;
  if (app) {
    await page?.evaluate(() => globalThis.__annotationBarrier?.restore()).catch(() => {});
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 });
      })
      .catch(() => {});
    await closeSmokeApplication(app).catch((error) => {
      errors.push("Electron cleanup: " + error.message);
      passed = false;
    });
  }
  try {
    const stop = await settleFixtureHostAfterQuit(testedCore, env, scratch, {
      host: originalHost,
      pid: guiPid,
    });
    facts.cleanup = {
      guiPid,
      hostPid: originalHost?.pid,
      stopRequestId: stop?.requestId,
      serviceExited: true,
    };
  } catch (error) {
    errors.push("Host cleanup: " + error.message);
    passed = false;
  }
  await fixture?.close();
  for (const server of [site, model]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await writeFile(join(scratch, "model-requests.json"), JSON.stringify(requests, null, 2));
  const files = [
    "renderer/src/App.tsx",
    "renderer/src/Preview.tsx",
    "renderer/src/BrowserRegionAnnotation.tsx",
    "renderer/src/BrowserRegionAnnotation.css",
    "renderer/src/EmbeddedBrowserPaneParts.tsx",
    "renderer/src/workbench.css",
    "renderer/src/Composer.tsx",
    "renderer/src/browserAnnotations.ts",
    "renderer/src/BrowserAnnotationAttachments.tsx",
    "renderer/src/Messages.tsx",
    "scripts/browser-annotation-smoke.mjs",
  ];
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        facts,
        source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
        hashes: Object.fromEntries(
          await Promise.all(
            files.map(async (f) => [
              f,
              createHash("sha256")
                .update(await readFile(join(gui, f)))
                .digest("hex"),
            ]),
          ),
        ),
        coreBinary: testedCore,
        coreBinarySHA256: createHash("sha256")
          .update(await readFile(testedCore))
          .digest("hex"),
        scope: `${packagedExecutable ? "packaged" : "source"} Electron/Main + native Host + recorded Core binary + local deterministic model; trusted GUI/navigation fixture and synthetic IME event; no OS dialog/focus, human, cross-origin grant or real-provider acceptance`,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
  if (!passed) process.exitCode = 1;
}
