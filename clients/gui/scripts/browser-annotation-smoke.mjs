import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { selectConversation, captureSmokeFailure } from "./smoke-navigation.mjs";

// 主流程与失败方式：同页截图、多条确认、跨聊天隔离、上传拒绝保留、显式重试及历史回取。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const {ServiceConnection,waitForServiceExit}=require(join(gui,"app/src/core/service-client.cjs"));
const scratch = await mkdtemp("/private/tmp/areal-browser-annotations-");
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
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ANNOTATIONS_RECEIVED" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
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
const packagedExecutable=process.env.AREAL_GUI_EXECUTABLE;
const env = {
  ...process.env,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: user,
  AREAL_CORE_CONFIG: join(user, ".areal/config.toml"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || join(root, "target/debug/areal"),
};
for (const key of ["AREAL_CORE_WORKSPACE", "AREAL_HARNESS_HOME", "AREAL_HARNESS_CONFIG"])
  delete env[key];
if(packagedExecutable)delete env.AREAL_CORE_BIN;
const testedCore=packagedExecutable?join(dirname(dirname(packagedExecutable)),"Resources/areal-core/bin/areal"):env.AREAL_CORE_BIN;
let app,
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
const settlePopup = async () => {
  await until(
    () =>
      page
        .locator('[data-slot="popover-content"]')
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
const command = async (name, params) => {
  const result = await page.evaluate(
    ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
try {
  app = await electron.launch({
    executablePath: packagedExecutable || require("electron"),
    args: packagedExecutable ? [] : [join(gui, "app")],
    env,
    timeout: 120000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await state()).connection?.state === "ready", "service ready");
  await app.evaluate(
    ({ app, dialog, BrowserWindow }, { workspace, origin }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
      const w = BrowserWindow.getAllWindows()[0];
      w.setSize(1440, 1000);
      app.focus({ steal: true });
      w.focus();
    },
    { workspace, origin: new URL(url).origin },
  );
  await page.evaluate(() => window.arealDesktop.chooseProject());
  const project = await until(
    async () => (await state()).projects.find((p) => p.root === workspace),
    "project",
  );
  // 人工批注不要求模型工具包；Core 仍处理消息与媒体。
  const first = await command("create", {
    projectId: project.id,
    profile: { id: "fixture", revision: "v1" },
  });
  const other = await command("create", {
    projectId: project.id,
    profile: { id: "fixture", revision: "v1" },
  });
  const identity = { projectId: project.id, threadId: first.threadId };
  await selectConversation(page, first.threadId);
  await page.keyboard.press("Meta+t");
  await page.locator(".preview-panel").waitFor();
  await app.evaluate(({ app, BrowserWindow }) => {
    app.setActivationPolicy("regular");
    const window=BrowserWindow.getAllWindows()[0];window.show();window.moveTop();
    app.focus({ steal: true });
    window.focus();
  });
  await until(
    () => app.evaluate(({ BrowserWindow }) => {const window=BrowserWindow.getAllWindows()[0];return window.isVisible()&&!window.isMinimized();}),
    "visible owned annotation window",
  );
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
  const staleCapture = await page.evaluate(q => window.arealDesktop.preview({...q,operation:"captureRegion"}), {...identity,pageId:(await page.evaluate(q=>window.arealDesktop.preview({...q,operation:"state"}),identity)).browser.pageId});
  await app.evaluate(({webContents}, id) => webContents.fromId(id).executeJavaScript(`document.getElementById('heading').outerHTML='<h1 id="heading">REPLACED_AFTER_FREEZE</h1>'`), nativeId);
  const staleResult = await page.evaluate(async q => {
    try{return {selected:await window.arealDesktop.preview(q)};}
    catch(e){return {error:e.message};}
  }, {...identity,pageId:staleCapture.pageId,operation:"selectElement",captureId:staleCapture.captureId,x:Math.floor(targets[0].x*staleCapture.viewport.bitmapWidth/targets[0].width),y:Math.floor(targets[0].y*staleCapture.viewport.bitmapHeight/targets[0].height)});
  assert.ok(staleResult.error||staleResult.selected?.available===false,"DOM replacement after freeze must not attach a replacement element identity to old pixels");
  await page.evaluate(q=>window.arealDesktop.preview(q), {...identity,pageId:staleCapture.pageId,operation:"endRegion",captureId:staleCapture.captureId});
  await app.evaluate(({webContents}, id) => webContents.fromId(id).executeJavaScript(`document.getElementById('heading').outerHTML='<h1 id="heading">ANNOTATION_HEADING</h1>'`), nativeId);
  checks.push("Post-freeze DOM replacement is rejected before element identity projection; region-only screenshot evidence remains available");
  await page.getByTestId("chat-input").fill("保留我的正文");
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
  for (const [index, target] of targets.entries()) {
    await page.mouse.click(
      box.x + (target.x / target.width) * box.width,
      box.y + (target.y / target.height) * box.height,
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
  // 在现有 RPC 的上传边界暂停并明确拒绝，验证锁定期间不能移除正在发送的标注。
  await app.evaluate(({app}) => {
    const req=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');
    const {ServiceConnection}=req('./src/core/service-client.cjs');
    const original=ServiceConnection.prototype.request;
    globalThis.__annotationUploadGate={entered:false};
    ServiceConnection.prototype.request=function(method,params,...rest){
      if(method==='command'&&params?.name==='media'&&!globalThis.__annotationUploadGate.entered){
        globalThis.__annotationUploadGate.entered=true;
        return new Promise((_,reject)=>{globalThis.__annotationUploadGate.release=()=>{ServiceConnection.prototype.request=original;reject(new Error('测试：延迟上传拒绝'));};});
      }
      return original.call(this,method,params,...rest);
    };
  });
  await page.getByTestId("chat-send-button").click();
  await until(()=>app.evaluate(()=>globalThis.__annotationUploadGate.entered),'gated media upload');
  await page.getByRole("button",{name:"2 条标注",exact:true}).click();
  await settlePopup();
  assert.equal(await page.getByRole('textbox',{name:'标注 1 内容'}).isDisabled(),true);
  assert.equal(await page.locator('.browser-annotation-attachment-card').getByRole('button',{name:/移除附件/}).count(),0,'locked thumbnail cannot expose an active remove control');
  await page.keyboard.press('Escape');
  await app.evaluate(()=>globalThis.__annotationUploadGate.release());
  await page.getByRole('alert').filter({hasText:'延迟上传拒绝'}).waitFor();
  await page.getByRole('button',{name:'2 条标注',exact:true}).waitFor();
  assert.equal(requests.length,0,'rejected upload cannot submit');
  checks.push('Pending upload locks thumbnail removal; known upload refusal retains both annotation files and comments for explicit retry');
  await page.locator("input[type=file]").setInputFiles({
    name: "oversize.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(17 * 1024 * 1024),
  });
  await page.getByTestId("chat-send-button").click();
  await page
    .getByRole("alert")
    .filter({ hasText: /附件|限制/ })
    .waitFor();
  await page.getByRole("button", { name: "2 条标注", exact: true }).waitFor();
  assert.equal(requests.length, 0, "upload refusal cannot submit the message");
  await page.getByRole("button", { name: "移除附件 oversize.bin", exact: true }).click();
  await page.getByRole("button", { name: "2 条标注", exact: true }).waitFor();
  await page.getByTestId("chat-send-button").click();
  await page
    .getByRole("button", { name: "已发送 2 条标注", exact: true })
    .waitFor({ timeout: 60000 });
  assert.equal(await page.getByTestId("browser-annotation-attachments").count(), 0);
  const history = await until(async () => {
    const thread = (await state()).projects.find((p) => p.id === project.id)?.state?.threads?.[
      first.threadId
    ];
    return thread?.turns?.at(-1)?.status === "completed" ? thread : null;
  }, "accepted Core history");
  facts.history = history;
  const modelBody = await until(() => requests.at(-1), "model request");
  const serialized = JSON.stringify(modelBody);
  assert.match(serialized, /ANNOTATION_COMMENT_1/);
  assert.match(serialized, /ANNOTATION_COMMENT_2_EDITED/);
  const images = modelBody.messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url") : [],
  );
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
  assert.equal(posts, 0, "annotation never clicks the page button");
  await page.getByRole("button", { name: "已发送 2 条标注", exact: true }).click();
  await page.getByText("ANNOTATION_COMMENT_2_EDITED", { exact: true }).waitFor();
  await settlePopup();
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
  // Origin 确认桩不用于退出确认；只关闭本次隔离 GUI，并结算其确切服务。
  const executable=app?await app.evaluate(()=>process.execPath).catch(()=>null):null;
  if(app){await app.evaluate(({dialog})=>{globalThis.__annotationUploadGate?.release?.();dialog.showMessageBox=async()=>({response:1});}).catch(()=>{});await app.close();}
  try{
    const home=join(scratch,"core"),metadata=JSON.parse(await readFile(join(home,"service.json"),"utf8"));
    assert.equal(execFileSync('/bin/ps',['-p',String(metadata.pid),'-o','command='],{encoding:'utf8'}).trim(),`${executable}${packagedExecutable?'':' '+join(gui,'app')} --areal-core-service`);
    const connection=new ServiceConnection();await connection.connect(metadata);
    try{await connection.request('hello',{protocol:metadata.protocol,identity:metadata.identity});
      const resources=await connection.request('resources',{operation:'inspect'});
      assert.ok(resources.every(p=>!p.activeTurns&&!p.unresolvedTools&&!p.resources.length));
      facts.cleanup={pid:metadata.pid,resources:resources.map(p=>({activeTurns:p.activeTurns,unresolvedTools:p.unresolvedTools,resources:p.resources.length})),stopACK:await until(async()=>{
        try{return await connection.request('stopService',{protocol:metadata.protocol,forUpdate:false},true);}
        catch(error){if(error.message==='后台仍有任务、可执行的排队消息或操作，完成或暂停队列后重试')return null;throw error;}
      },'isolated adapter close operations settle before safe stop')};
    }finally{connection.close();}
    await waitForServiceExit(home,metadata);facts.cleanup.serviceExited=true;
  }catch(e){errors.push('Cleanup: '+e.message);passed=false;}
  for (const server of [site, model]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
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
        scope:
          `${packagedExecutable?"packaged":"source"} Electron/Main + adapter + recorded Core binary + local deterministic model; trusted GUI/navigation fixture and synthetic IME event; no OS dialog/focus, human, cross-origin grant or real-provider acceptance`,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
