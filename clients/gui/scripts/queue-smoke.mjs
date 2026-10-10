import {
  captureSmokeFailure,
  resizeConversation,
  createProjectConversation,
  selectConversation,
} from "./smoke-navigation.mjs";
import assert from "node:assert/strict";

import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(gui, "app");
const require = createRequire(join(desktop, "package.json"));
const { _electron: electron } = require("playwright-core");
const root = resolve(gui, "../..");
const binary = process.env.AREAL_GUI_EXECUTABLE
  ? resolve(dirname(process.env.AREAL_GUI_EXECUTABLE), "../Resources/areal-core/bin/areal")
  : process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
assert.ok(binary, "AREAL_CORE_BIN must point to the actual built Core");
const scratch = await mkdtemp("/private/tmp/areal-gui-");
const workspace = join(scratch, "workspace");
await mkdir(workspace);
await mkdir(join(scratch, "user-home"));
execFileSync("git", ["init", "-b", "main"], {
  cwd: workspace,
  stdio: "ignore",
});
await writeFile(join(workspace, "hello.ts"), 'export const hello = "world";\n');
execFileSync("git", ["add", "."], { cwd: workspace });
execFileSync(
  "git",
  ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"],
  { cwd: workspace, stdio: "ignore" },
);
await writeFile(join(workspace, "hello.ts"), 'export const hello = "AReaL";\n');
const skill = join(scratch, "skill");
await mkdir(skill);
await writeFile(
  join(skill, "SKILL.md"),
  "---\nname: fixture-skill\ndescription: Deterministic test skill\n---\nExplain the fixture project.\n",
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    skills: [{ id: "fixture-skill", revision: "v1", root: skill }],
    profiles: [
      {
        id: "standard",
        revision: "v1",
        displayName: "标准",
        instructions: "Complete the task",
        allowThreadProcesses: true,
        approvalTools: ["fs_create"],
        skills: [{ id: "fixture-skill", revision: "v1" }],
      },
    ],
  }),
);
// HTTP/SSE 只固定模型边界，Core 队列与活动轮次真实运行。
const received = [];
const live = new Set();
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  received.push(JSON.parse(raw));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "等待队列验收" }, finish_reason: null }] })}\n\n`,
  );
  live.add(res);
  res.on("close", () => live.delete(res));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
const config = join(scratch, "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint=${JSON.stringify(endpoint)}\n`,
);
const env = {
  ...process.env,
  AREAL_GUI: "workbench",
  AREAL_BACKEND: "areal",
  AREAL_CORE_BIN: binary,
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user-home"),
  AREAL_HARNESS_HOME: join(scratch, "runtime"),
  AREAL_CORE_CONFIG: config,
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
};
delete env.AREAL_CORE_WORKSPACE;
if (process.env.AREAL_GUI_EXECUTABLE) delete env.AREAL_CORE_BIN;
let app,
  page,
  passed = false;
const errors = [],
  frames = [],
  checks = [];
const button = (name) => page.getByRole("button", { name, exact: true });
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
async function call(name, params) {
  const result = await page.evaluate(
    async ({ name, params }) => {
      if (Array.isArray(params.bytes)) params.bytes = new Uint8Array(params.bytes);
      return window.arealDesktop.command(name, params);
    },
    {
      name,
      params: params.bytes instanceof Uint8Array ? { ...params, bytes: [...params.bytes] } : params,
    },
  );
  if (!result.ok) throw Error(result.error.message);
  return result.value;
}
async function until(predicate, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const s = await state();
    if (predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error("Timeout: " + label);
}
async function shot(name) {
  const clip = await page.evaluate(() => {
    const boxes = [
      ...document.querySelectorAll(
        '.composer-dock, [data-slot="popover-content"], [data-testid="composer-catalog"], [data-slot="dropdown-menu-content"]',
      ),
    ]
      .filter(
        (element) =>
          getComputedStyle(element).visibility !== "hidden" &&
          getComputedStyle(element).display !== "none",
      )
      .map((element) => element.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
    if (!boxes.length) return undefined;
    const x = Math.max(0, Math.min(...boxes.map((box) => box.left)) - 8);
    const y = Math.max(0, Math.min(...boxes.map((box) => box.top)) - 8);
    return {
      x,
      y,
      width: Math.min(innerWidth, Math.max(...boxes.map((box) => box.right)) + 8) - x,
      height: Math.min(innerHeight, Math.max(...boxes.map((box) => box.bottom)) + 8) - y,
    };
  });
  await page.screenshot({
    clip,
    path: join(scratch, name + ".png"),
    scale: "css",
    animations: "disabled",
  });
  frames.push(name + ".png");
}
async function launch() {
  app = await electron.launch({
    executablePath: process.env.AREAL_GUI_EXECUTABLE || require("electron"),
    args: process.env.AREAL_GUI_EXECUTABLE ? [] : [desktop],
    env,
    timeout: 120000,
  });
  app.process().stderr.on("data", (d) => {
    if (String(d).includes("Error")) process.stderr.write(d);
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("[data-testid=areal-workbench]").waitFor({ timeout: 120000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
}
async function quit() {
  if (!app) return;
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await app.close();
  app = null;
}
console.log("GUI evidence:", scratch);
try {
  await launch();
  await page.evaluate(() => localStorage.setItem("areal-gui:theme", "data-dense"));
  await page.reload();
  await page.getByTestId("areal-workbench").waitFor();
  assert.deepEqual(
    await app.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return {
        sandbox: p.sandbox,
        contextIsolation: p.contextIsolation,
        nodeIntegration: p.nodeIntegration,
      };
    }),
    { sandbox: true, contextIsolation: true, nodeIntegration: false },
  );
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await button("不在项目中工作").click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until((s) => s.projects[0]?.state?.connected, "project ready");
  const pid = (await state()).projects[0].id;
  await call("manage", {
    projectId: pid,
    operation: "providerSave",
    expectedRevision: 0,
    provider: {
      id: "fixture-provider",
      revision: 0,
      protocol: "chatCompletions",
      endpoint,
      models: ["fixture", "fixture-alt"],
      parameters: {},
    },
  });
  await until(
    (s) => s.projects[0].models.some((model) => model.modelId === "fixture-alt"),
    "provider catalog",
  );
  const input = () => page.getByTestId("chat-input");
  await input().fill("hold queue");
  await button("发送").click();
  await until(
    (s) =>
      Object.values(s.projects[0].state.threads).some(
        (t) => t.turns?.at(-1)?.status === "inProgress",
      ) && received.length > 0,
    "held active turn",
  );
  const tid = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  const key = `areal-gui:draft:${pid}:${tid}`;
  const queue = (s) => s.projects[0].state.queues[tid];
  const pending = (s) => queue(s).items.filter((i) => i.status === "pending");
  const row = (text) =>
    page
      .locator(".composer-queue-row")
      .filter({ has: page.locator(".composer-queue-copy", { hasText: text }) });
  const more = async (text) => {
    await row(text)
      .getByRole("button", { name: /更多操作/ })
      .click();
  };
  const startEdit = async (text) => {
    await more(text);
    await page.getByRole("menuitem", { name: "编辑消息", exact: true }).click();
    await page.waitForFunction(
      (key) => JSON.parse(localStorage.getItem(`${key}:queue-edit`) ?? "null")?.phase === "editing",
      key,
    );
  };
  for (const text of ["1", "2", "3"]) {
    await input().fill(text);
    await button("发送").click();
    await until(
      (s) => pending(s).some((i) => i.input.some((p) => p.text === text)),
      `enqueue ${text}`,
    );
  }
  await shot("01-queue");
  // 指针拖动、键盘和菜单均提交完整 ID 顺序，Core 确认前保留原行。
  const grip = row("3").getByRole("button", { name: /调整顺序/ });
  const source = await grip.boundingBox(),
    target = await row("1").boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 });
  await page.mouse.up();
  await until(
    (s) =>
      pending(s)
        .map((i) => i.input[0].text)
        .join() === "3,1,2",
    "pointer reorder",
  );
  await row("3")
    .getByRole("button", { name: /调整顺序/ })
    .press("ArrowDown");
  await until(
    (s) =>
      pending(s)
        .map((i) => i.input[0].text)
        .join() === "1,3,2",
    "keyboard reorder",
  );
  await more("3");
  await shot("02-menu");
  await page.getByRole("menuitem", { name: "上移", exact: true }).click();
  await until(
    (s) =>
      pending(s)
        .map((i) => i.input[0].text)
        .join() === "3,1,2",
    "menu reorder",
  );
  checks.push(
    "pointer, keyboard and menu reorder confirmed by real Core; full pending order and boundary controls",
  );
  // 队列附件保留 Core URL，原未发送文件/Skill/正文留在主草稿所有者。
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#4085fa";
    ctx.fillRect(0, 0, 64, 64);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const media = await call("media", {
    projectId: pid,
    threadId: tid,
    operation: "upload",
    mime: "image/png",
    bytes: new Uint8Array(Buffer.from(png, "base64")),
  });
  const q = queue(await state()),
    first = pending(await state())[0];
  await call("queueEdit", {
    projectId: pid,
    threadId: tid,
    operation: "update",
    expectedRevision: q.revision,
    queueItemId: first.id,
    text: "3",
    attachments: [{ type: "image", url: media.uri }],
  });
  const configBefore = JSON.stringify(pending(await state())[0].configuration);
  await input().fill("原未发送草稿");
  await page.locator("input[type=file]").setInputFiles({
    name: "original.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("ORIGINAL_FILE"),
  });
  await button("添加功能与 Skills").click();
  await page.getByRole("option").filter({ hasText: "Deterministic test skill" }).click();
  assert.equal(await page.locator(".composer-skill-tag").count(), 1);
  await startEdit("3 [附件]".replace(" ", "\n"));
  assert.equal(await input().textContent(), "3");
  assert.equal(await page.locator(".composer-queue textarea").count(), 0);
  assert.equal(await page.getByTestId("composer-queued-attachment").count(), 1);
  await page.getByTestId("composer-queued-attachment").locator("img").waitFor();
  assert.ok(await button("模型").isDisabled());
  await shot("03-editing");
  await input().fill("切换后保留的编辑");
  await createProjectConversation(page, "workspace");
  await page.waitForFunction(
    (tid) => document.querySelector('[data-testid="areal-workbench"]').dataset.threadId !== tid,
    tid,
  );
  await input().fill("另一对话草稿");
  await selectConversation(page, tid);
  assert.equal(await input().textContent(), "切换后保留的编辑");
  assert.equal(queue(await state()).paused, true);
  assert.equal(await page.getByTestId("composer-queued-attachment").count(), 1);
  checks.push(
    "task navigation preserves queued edit body and retained attachment without resuming queue or touching another draft",
  );
  await resizeConversation(app, page, 520, 760);
  assert.equal(
    await page.locator(".composer-queue").evaluate((e) => e.scrollWidth <= e.clientWidth),
    true,
  );
  assert.ok(await button("保存排队消息").isVisible());
  await shot("04-narrow-editing");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  await button("展开侧栏").click();
  await input().fill("3 已编辑");
  await button("保存").click();
  await until(
    (s) => pending(s)[0]?.input[0]?.text === "3 已编辑" && !queue(s).paused,
    "save original position and resume",
  );
  assert.equal(await input().textContent(), "原未发送草稿");
  assert.equal(await button("移除附件 original.txt").count(), 1);
  assert.equal(await page.locator(".composer-skill-tag").count(), 1);
  const edited = pending(await state())[0];
  assert.equal(edited.id, first.id);
  assert.equal(JSON.stringify(edited.configuration), configBefore);
  assert.equal(edited.input[1].url, media.uri);
  await startEdit("1");
  await input().fill("不保存的修改");
  await button("取消").click();
  await until((s) => !queue(s).paused, "cancel restores original unpaused state");
  assert.equal(await input().textContent(), "原未发送草稿");
  assert.equal(pending(await state())[1].input[0].text, "1");
  checks.push(
    "pause confirmed before main Composer editing; save/cancel restores body, original File and Skill tag; queued blob URL, position, model/mode retained",
  );
  // 原暂停状态与外部变更：不覆盖新 revision、不自动恢复外部状态。
  await more("1");
  await page.getByRole("menuitem", { name: "暂停队列", exact: true }).click();
  await until((s) => queue(s).paused, "user paused");
  await startEdit("1");
  await input().fill("未提交外部冲突");
  const changed = queue(await state());
  await call("queueEdit", {
    projectId: pid,
    threadId: tid,
    operation: "update",
    expectedRevision: changed.revision,
    queueItemId: pending(await state())[2].id,
    text: "2 外部更新",
  });
  await page.getByRole("alert").filter({ hasText: "队列或消息已有更新" }).waitFor();
  assert.equal(await input().textContent(), "未提交外部冲突");
  assert.ok(await button("保存").isDisabled());
  await button("取消").click();
  assert.equal(queue(await state()).paused, true);
  assert.equal(await input().textContent(), "原未发送草稿");
  await startEdit("1");
  await input().fill("外部删除后保留");
  const deleted = queue(await state());
  await call("queueEdit", {
    projectId: pid,
    threadId: tid,
    operation: "remove",
    expectedRevision: deleted.revision,
    queueItemId: deleted.items.find((i) => i.input[0].text === "1").id,
  });
  await page.getByRole("alert").filter({ hasText: "队列或消息已有更新" }).waitFor();
  assert.equal(await input().textContent(), "外部删除后保留");
  await button("取消").click();
  checks.push(
    "external update/deletion blocks overwrite and retains edit draft; cancel preserves original paused state",
  );
  // 真实 Core 已落盘后丢弃响应，验证对账与不自动重发。
  await app.evaluate(
    (_, clientPath) => {
      const { ServiceConnection } = process.mainModule.require(clientPath);
      globalThis.queueFixtureConnection = ServiceConnection;
      const original = ServiceConnection.prototype.request;
      ServiceConnection.prototype.fixtureCalls = [];
      ServiceConnection.prototype.request = async function (method, params, mutation) {
        const operation =
          method === "command" && params.name === "queueEdit" ? params.request.operation : null;
        if (operation)
          this.fixtureCalls.push({
            method: `areal/queue/${operation}`,
            requestId: params.request.requestId,
          });
        globalThis.queueFixtureLiveConnection = this;
        const result = await original.call(this, method, params, mutation);
        if (operation && ServiceConnection.prototype.fixtureDrop === `areal/queue/${operation}`) {
          ServiceConnection.prototype.fixtureDrop = null;
          throw Object.assign(new Error("fixture dropped accepted response"), {
            submissionUnknown: true,
          });
        }
        return result;
      };
    },
    join(desktop, "src/core/service-client.cjs"),
  );
  await call("queueEdit", {
    projectId: pid,
    threadId: tid,
    operation: "resume",
    expectedRevision: queue(await state()).revision,
  });
  await app.evaluate(() => {
    globalThis.queueFixtureConnection.prototype.fixtureDrop = "areal/queue/pause";
  });
  await more("2 外部更新");
  await page.getByRole("menuitem", { name: "编辑消息", exact: true }).click();
  await button("核对编辑操作").waitFor();
  assert.equal(await input().textContent(), "原未发送草稿");
  await button("核对编辑操作").click();
  await page.waitForFunction(
    (key) => JSON.parse(localStorage.getItem(`${key}:queue-edit`)).phase === "editing",
    key,
  );
  await input().fill("断线时保留的编辑");
  await call("queue", { projectId: pid, threadId: tid });
  await app.evaluate(() => globalThis.queueFixtureLiveConnection.socket.terminate());
  await until((s) => !s.projects[0].state.connected, "GUI service disconnected");
  assert.ok(await button("保存").isDisabled());
  assert.equal(await input().textContent(), "断线时保留的编辑");
  await call("connectService", {});
  await until((s) => s.projects[0].state.connected, "explicit reconnect");
  assert.equal(queue(await state()).paused, true);
  await app.evaluate(() => {
    globalThis.queueFixtureConnection.prototype.fixtureDrop = "areal/queue/resume";
  });
  await button("取消").click();
  await button("核对编辑操作").waitFor();
  await button("核对编辑操作").click();
  await page.waitForFunction((key) => !localStorage.getItem(`${key}:queue-edit`), key);
  assert.equal(await input().textContent(), "原未发送草稿");
  assert.equal(queue(await state()).paused, false);
  checks.push(
    "pause/resume lost accepted responses reconcile explicitly; actual GUI/service disconnect preserves edit and disables save until reconnect",
  );
  await call("queueEdit", {
    projectId: pid,
    threadId: tid,
    operation: "pause",
    expectedRevision: queue(await state()).revision,
  });
  await startEdit("2 外部更新");
  await input().fill("2 对账更新");
  await app.evaluate(() => {
    globalThis.queueFixtureConnection.prototype.fixtureDrop = "areal/queue/update";
  });
  await button("保存").click();
  await page.getByRole("alert").filter({ hasText: "编辑内容已保留，不会自动重发" }).waitFor();
  assert.equal(await input().textContent(), "2 对账更新");
  assert.ok(await button("保存").isDisabled());
  await button("核对编辑操作").click();
  await until(
    (s) =>
      !s.projects[0].pending.length && pending(s).some((i) => i.input[0].text === "2 对账更新"),
    "update receipt reconciled",
  );
  await page.waitForFunction((key) => !localStorage.getItem(`${key}:queue-edit`), key);
  assert.equal(await input().textContent(), "原未发送草稿");
  assert.equal(queue(await state()).paused, true);
  const mutations = await app.evaluate(
    () => globalThis.queueFixtureConnection.prototype.fixtureCalls,
  );
  assert.equal(mutations.filter((entry) => entry.method === "areal/queue/update").length, 1);
  checks.push(
    "accepted update response loss keeps edit draft locked; receipt reconciliation restores original draft without resubmission",
  );
  // 原子转为引导：当前轮次出现一条消息，队列退出 pending，未知响应只查收据。
  await app.evaluate(() => {
    globalThis.queueFixtureConnection.prototype.fixtureDrop = "areal/queue/steer";
  });
  await row("2 对账更新").getByRole("button", { name: /引导/ }).click();
  await button("核对队列操作").waitFor();
  await button("核对队列操作").click();
  await until(
    (s) => !s.projects[0].pending.length && queue(s).items.some((i) => i.status === "steered"),
    "steer receipt",
  );
  const after = await state();
  const transferred = queue(after).items.find((i) => i.input[0].text === "2 对账更新");
  assert.equal(transferred.status, "steered");
  const messages = after.projects[0].state.threads[tid].turns
    .flatMap((t) => t.items)
    .filter((i) => i.type === "userMessage" && i.content.some((p) => p.text === "2 对账更新"));
  assert.equal(messages.length, 1);
  assert.equal(
    (await app.evaluate(() => globalThis.queueFixtureConnection.prototype.fixtureCalls)).filter(
      (entry) => entry.method === "areal/queue/steer",
    ).length,
    1,
  );
  checks.push(
    "atomic queued-to-steer reaches active Turn exactly once; lost accepted response reconciles one durable transfer",
  );
  await row("3 已编辑\n[附件]")
    .getByRole("button", { name: /删除排队消息/ })
    .click();
  await until((s) => pending(s).length === 0, "empty queue");
  await page.waitForFunction(() => !document.querySelector(".composer-queue-row"));
  await call("stop", { projectId: pid, threadId: tid });
  await until(
    (s) => s.projects[0].state.threads[tid].turns.at(-1)?.status !== "inProgress",
    "turn stop",
  );
  checks.push("delete waits for Core; empty rows disappear; active turn explicitly settles");
  assert.deepEqual(errors, []);
  passed = true;
  console.log(JSON.stringify({ passed, scratch, checks }));
} catch (error) {
  console.error("renderer errors", errors);
  frames.push(
    ...(await captureSmokeFailure(page, scratch, error)).filter((file) => file.endsWith(".png")),
  );
  throw error;
} finally {
  await quit();
  try {
    const { ServiceConnection } = require(join(desktop, "src/core/service-client.cjs"));
    const connection = new ServiceConnection();
    try {
      await connection.connect(
        JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8")),
      );
      await connection.request("stopService", { protocol: "areal.desktop-service.v1" }, true);
      checks.push("explicit safe service stop completes");
    } finally {
      connection.close();
    }
  } catch (error) {
    console.error("Adapter fixture cleanup:", error.message);
    if (passed) {
      passed = false;
      process.exitCode = 1;
      errors.push(`Explicit safe stop failed: ${error.message}`);
    }
    // 仅清理本次隔离 home 中的服务；失败不遗留模型任务或后台进程。
    try {
      const instances = JSON.parse(
        execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8" }),
      );
      for (const instance of instances)
        if (instance.workspace === workspace && instance.state !== "stopped") {
          execFileSync(
            binary,
            ["service", "stop", "--instance", instance.serviceId, "--cancel", "--json"],
            { env, timeout: 120000, stdio: "pipe" },
          );
        }
    } catch (failure) {
      console.error("Core fixture cleanup:", failure.message);
    }
    try {
      const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
      process.kill(metadata.pid, "SIGTERM");
    } catch {}
  }
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  const sourceFiles = {};
  for (const path of execFileSync(
    "git",
    ["ls-files", "--modified", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .toString()
    .split("\0")
    .filter(Boolean)) {
    sourceFiles[path] = createHash("sha256")
      .update(await readFile(join(root, path)))
      .digest("hex");
  }
  const diff = execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root });
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
        sourceFiles,
        binarySha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
        diffSha256: createHash("sha256").update(diff).digest("hex"),
        binary,
        platform: process.platform,
        arch: process.arch,
        runtime: "real Electron + real Rust Core/Runtime + deterministic local HTTP/SSE model",
        nativeDialogs: "project picker and archive/quit confirmations injected",
        scratch,
        frames,
        checks,
        errors,
      },
      null,
      2,
    ),
  );
}
