import assert from "node:assert/strict";

import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
const received = [];
let finishBackground, finishAgentParent;
const server = createServer(async (req, res) => {
  if (req.url.startsWith("/preview")) {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<html><body style="font:20px system-ui;background:#edf5f1;padding:48px"><h1>Project preview</h1><p>AReaL local workspace</p><a href="/preview?next">Next page</a><button onclick="this.textContent=\'Preview clicked\'">Try preview</button></body></html>',
    );
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  received.push(body);
  if (body.stream === false) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
    return;
  }
  const msgs = body.messages ?? [],
    last = msgs.findLastIndex((m) => m.role === "user"),
    content = msgs[last]?.content;
  const text =
    typeof content === "string" ? content : (content ?? []).map((x) => x.text ?? "").join("");
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  if (text.includes("后台持续执行")) {
    send({ content: "后台开始。" });
    finishBackground = () => {
      send({ content: "后台完成。" });
      send({}, "stop");
      res.end("data: [DONE]\n\n");
    };
    return;
  }
  if (text.includes("启动子任务") && msgs.slice(last + 1).some(m => m.role === "tool")) {
    send({ content: "父任务继续处理，子任务运行中。" });
    finishAgentParent = () => {
      send({ content: "父任务已完成。" }); send({}, "stop"); res.end("data: [DONE]\n\n");
    };
    return;
  }
  if ((text.includes("子任务完成") || text === "检查当前项目") && !msgs.slice(last + 1).some(m => m.role === "tool")) {
    send({ tool_calls: [{ index: 0, id: "child-read", type: "function", function: { name: "fs_read", arguments: JSON.stringify({ path: "workspace://repo/hello.ts" }) } }] });
    send({}, "tool_calls"); res.end("data: [DONE]\n\n"); return;
  }
  if (text.includes("等待停止")) {
    send({ content: "正在运行，等待下一步指令。" });
    return;
  }
  if (text.includes("审批写入") && !msgs.slice(last + 1).some((m) => m.role === "tool")) {
    send({
      tool_calls: [
        {
          index: 0,
          id: "write",
          type: "function",
          function: {
            name: "fs_create",
            arguments: JSON.stringify({
              path: "approved.txt",
              text: "approved once",
            }),
          },
        },
      ],
    });
    send({}, "tool_calls");
  } else if (text.includes("需要问答") && !msgs.slice(last + 1).some((m) => m.role === "tool")) {
    send({
      tool_calls: [
        {
          index: 0,
          id: "question",
          type: "function",
          function: {
            name: "ask_user_question",
            arguments: JSON.stringify({
              questions: [
                {
                  id: "choice",
                  title: "选择实现方式",
                  options: ["最小修改", "重构"],
                  allowFreeText: false,
                },
              ],
            }),
          },
        },
      ],
    });
    send({}, "tool_calls");
  } else if (text.includes("启动子任务") && !msgs.slice(last + 1).some((m) => m.role === "tool")) {
    send({
      tool_calls: ["子任务完成", "子任务等待停止", "子任务完成 · 检查参考来源"].map((prompt, index) => ({
        index,
        id: `child-${index}`,
        type: "function",
        function: {
          name: "agent_spawn_configured",
          arguments: JSON.stringify({ input: [{ type: "text", text: prompt }], workspaceMode: "sharedReadOnly" }),
        },
      })),
    });
    send({}, "tool_calls");
  } else {
    send({
      content:
        "已完成工作区检查。\n\n- 文件已读取\n- 下一步可以查看改动\n\n```ts\nconst ready = true;\n```",
    });
    send({}, "stop");
  }
  res.write(
    `data: ${JSON.stringify({ id: "fixture", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
  previewUrl = `http://127.0.0.1:${server.address().port}/preview`;
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
    async ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  if (!result.ok) throw Error(result.error.message);
  return result.value;
}
async function until(predicate, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const s = await state();
    if (await predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error("Timeout: " + label);
}
async function shot(name) {
  await page.screenshot({
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
async function openPanel(name) {
  if (await button("返回工作区").isVisible()) await button("返回工作区").click();
  if (name === "终端") {
    await button(name).click();
    return;
  }
  await button("任务操作").click();
  await page.getByRole("menuitem", { name, exact: true }).click();
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
  const sandbox = await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
    };
  });
  assert.deepEqual(sandbox, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  await shot("01-empty");
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await button("不在项目中工作").click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until((s) => s.projects[0]?.state?.connected, "project ready");
  const pid = (await state()).projects[0].id;
  const input = () => page.locator("[data-testid=chat-input]");
  const turnCountOf = (s) =>
    Object.values(s.projects[0].state.threads).reduce((n, t) => n + (t.turns?.length ?? 0), 0);
  const send = async (text) => {
    const count = turnCountOf(await state());
    await input().fill(text);
    await button("发送").click();
    await until((s) => turnCountOf(s) > count, "turn admission");
  };
  // 通过已有提示入口复现旧错误；后续真实发送不应继续展示它。
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent("areal:toast", {
        detail: "thread is busy or the target turn is stale",
      }),
    ),
  );
  await page.locator(".error-banner").waitFor();
  await send("检查当前项目");
  await until(
    (s) =>
      Object.values(s.projects[0].state.threads).some(
        (t) => t.turns?.at(-1)?.status === "completed",
      ),
    "first send",
  );
  await page.waitForFunction(() => !document.querySelector(".error-banner"));
  const tid = await page.locator("[data-testid=areal-workbench]").getAttribute("data-thread-id");
  const current = (s) => s.projects[0].state.threads[tid];
  assert.ok(tid);
  await shot("02-conversation");
  checks.push("sandboxed Electron; project picker; first send; real Core/Runtime and local SSE");
  checks.push("new message clears previous error banner after real Core acceptance");
  // 子对话只改变侧面板；真实子 Thread、工具记录与停止结果由 Core 提供。
  const reference = await page.evaluate(async ({ pid }) => {
    const response = await window.arealDesktop.command("media", { projectId: pid, threadId: document.querySelector("[data-testid=areal-workbench]").dataset.threadId, operation: "upload", mime: "image/png", bytes: Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII="), char => char.charCodeAt(0)) });
    if (!response.ok) throw Error(response.error.message);
    return response.value;
  }, { pid });
  await call("send", { projectId: pid, threadId: tid, text: "启动子任务", attachments: [{ type: "image", url: reference.uri }] });
  await until(async () => (await call("manage", { projectId: pid, parentThreadId: tid, operation: "agents", limit: 30 })).data.length === 3, "three real children");
  const children = (await call("manage", { projectId: pid, parentThreadId: tid, operation: "agents", limit: 30 })).data;
  const doneChild = children.find(t => t.preview === "子任务完成");
  const liveChild = children.find(t => t.preview === "子任务等待停止");
  assert.ok(doneChild && liveChild);
  const backgroundProcess = await call("manage", { projectId: pid, threadId: tid, operation: "processStart", requestId: randomUUID(), argv: ["/bin/sh", "-c", "printf 'Resource process ready\\n'; sleep 300"], cwd: "workspace://repo", lifetime: "thread", tty: false, timeoutMs: 600000 });
  assert.ok(backgroundProcess.id);
  const mainWidth = await page.locator("[data-testid=chat-view]").evaluate(el => el.getBoundingClientRect().width);
  await button("任务资源").click();
  const resources = page.getByRole("region", { name: "任务资源", exact: true });
  await resources.getByRole("button", { name: `打开 ${liveChild.id} 子对话`, exact: true }).waitFor();
  await resources.getByRole("region", { name: "工作区变更", exact: true }).waitFor();
  await resources.getByRole("heading", { name: "后台进程", exact: false }).waitFor();
  assert.equal(await resources.getByRole("button", { name: /子对话$/ }).count(), 3);
  assert.equal(await page.locator("[data-testid=chat-view]").evaluate(el => el.getBoundingClientRect().width), mainWidth);
  assert.equal(await page.locator(".task-resources-popup").evaluate(el => el.getBoundingClientRect().width), 332);
  await page.keyboard.press("Escape");
  await resources.waitFor({ state: "hidden" });
  assert.equal(await button("任务资源").evaluate(el => el === document.activeElement), true);
  await button("任务资源").click();
  await resources.getByRole("button", { name: "预览图片 消息图片", exact: true }).waitFor();
  await resources.getByRole("button", { name: "预览图片 消息图片", exact: true }).click();
  await page.getByRole("button", { name: "关闭图片预览", exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.closest('[data-slot="dialog-content"]'));
  await page.locator('[data-slot="dialog-content"]').evaluate(async el => {
    await Promise.all(el.getAnimations().map(animation => animation.finished));
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "关闭图片预览", exact: true }).waitFor({ state: "hidden" });
  await resources.waitFor();
  await resources.getByRole("button", { name: /变更.*个文件/ }).waitFor();
  assert.ok(await resources.getByRole("button", { name: /变更.*1 个文件/ }).count());
  await resources.getByRole("heading", { name: "workspace", exact: true }).click();
  await page.locator(".task-resources-popup").evaluate(async el => {
    await Promise.all(el.getAnimations().map(animation => animation.finished));
  });
  await writeFile(join(scratch, "resource-layout.json"), JSON.stringify(await page.locator(".task-resources-popup").evaluate(el => ({
    width: el.getBoundingClientRect().width, background: getComputedStyle(el).backgroundColor, backgroundImage: getComputedStyle(el).backgroundImage,
    token: getComputedStyle(el).getPropertyValue("--color-popover"),
    menuToken: getComputedStyle(el).getPropertyValue("--color-menu"),
    pageBackground: getComputedStyle(el).getPropertyValue("--color-background"),
    headings: [...el.querySelectorAll("h3")].map(h => ({ text: h.textContent, weight: getComputedStyle(h).fontWeight })),
  })), null, 2));
  await shot("02r-task-resources");
  await page.locator(".task-resources-popup").screenshot({ path: join(scratch, "02r-task-resources-crop.png") });
  const liveAvatar = await resources.locator(`[data-agent-avatar="${liveChild.id}"]`).getAttribute("src");
  assert.ok(liveAvatar.startsWith("data:image/svg+xml"));
  assert.equal(await page.locator("[data-testid=chat-view]").getByRole("button", { name: `打开 ${liveChild.id} 子对话`, exact: true }).innerText(), "已创建 1 个智能体");
  await resources.getByRole("button", { name: `打开 ${liveChild.id} 子对话`, exact: true }).click();
  await page.locator(`[data-agent-conversation="${liveChild.id}"] [data-turn-status=inProgress]`).waitFor();
  assert.equal(await page.locator("[data-testid=areal-workbench]").getAttribute("data-thread-id"), tid);
  assert.equal(await input().count(), 1);
  await input().fill("主对话草稿保持");
  assert.equal(await page.locator(`.agent-conversation-heading [data-agent-avatar="${liveChild.id}"]`).getAttribute("src"), liveAvatar);
  assert.equal(await page.locator(`[data-testid=chat-view] [data-agent-avatar="${liveChild.id}"]`).getAttribute("src"), liveAvatar);
  await shot("02a-agent-running");
  await page.locator(`[aria-label="关闭 Agent · ${liveChild.id.slice(0, 8)} 标签"]`).click();
  const afterClose = await call("manage", { projectId: pid, parentThreadId: tid, operation: "agentWait", threadIds: [liveChild.id], timeoutMs: 0 });
  assert.equal(afterClose.data[0].status, "inProgress");
  await page.locator("[data-testid=chat-view]").getByRole("button", { name: `打开 ${liveChild.id} 子对话`, exact: true }).click();
  await page.locator(`[data-agent-conversation="${liveChild.id}"] [data-turn-status=inProgress]`).waitFor();
  await button("任务资源").click();
  await resources.getByRole("button", { name: /变更.*个文件/ }).click();
  assert.equal(await page.locator("[data-testid=workspace-review]").getAttribute("data-review-source"), "git");
  await page.getByRole("button", { name: "改动范围", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "改动范围", exact: true }).innerText(), "未暂存的更改");
  await button("任务资源").click();
  await resources.getByRole("button", { name: `打开 ${doneChild.id} 子对话`, exact: true }).click();
  await page.locator(`[data-agent-conversation="${doneChild.id}"] [data-turn-status=completed]`).waitFor();
  assert.equal(await input().innerText(), "主对话草稿保持");
  const donePane = page.locator(`[data-agent-conversation="${doneChild.id}"]`);
  assert.equal(await donePane.locator(".user-message").count(), 1);
  assert.ok(await donePane.locator(".tool-event").count() > 0);
  await donePane.locator(".turn-progress-summary").click();
  await donePane.getByRole("button", { name: "查看工具原始记录", exact: true }).click();
  await donePane.getByLabel("工具结果", { exact: true }).waitFor();
  await shot("02b-agent-completed");
  await page.locator(`[aria-label="关闭 Agent · ${doneChild.id.slice(0, 8)} 标签"]`).click();
  await page.getByRole("tab", { name: `Agent · ${liveChild.id.slice(0, 8)}`, exact: true }).click();
  await call("stop", { projectId: pid, threadId: liveChild.id });
  await page.locator(`[data-agent-conversation="${liveChild.id}"] [data-turn-status=interrupted]`).waitFor();
  await button("新聊天").click();
  assert.equal(await page.locator("[data-agent-conversation]").count(), 0);
  await page.locator(`#areal-sidebar [data-thread-id="${tid}"]`).first().click();
  await page.locator(`[data-agent-conversation="${liveChild.id}"] [data-turn-status=interrupted]`).waitFor();
  assert.equal(await input().innerText(), "主对话草稿保持");
  assert.ok(finishAgentParent);
  finishAgentParent();
  await until(s => current(s).turns.at(-1)?.status === "completed", "parent completes after child stop");
  await shot("02c-agent-interrupted");
  await button("关闭面板").click();
  await input().fill("");
  await call("manage", { projectId: pid, threadId: tid, operation: "processTerminate", id: backgroundProcess.id });
  checks.push("Core children: compact 332px four-group resources, Escape/focus, running/completed/interrupted side conversations, switching/closing preserve parent and composer draft");
  // 已有完整验收通过后，视觉行文修正只重跑其真实资源/事件路径。
  if (!process.env.AREAL_GUI_RESOURCE_SMOKE_ONLY) {
  await send("审批写入");
  await button("允许一次").click();
  await until((s) => current(s).turns.at(-1)?.status === "completed", "approved write");
  assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), "approved once");
  await send("需要问答");
  await page.getByRole("radio", { name: /最小修改/ }).click();
  await until((s) => current(s).turns.at(-1)?.status === "completed", "question resumed");
  checks.push("tool approval executes filesystem write; question reply resumes same turn");
  await send("等待停止");
  await until((s) => current(s).turns.at(-1)?.status === "inProgress", "running");
  await call("stop", { projectId: pid, threadId: tid });
  await until((s) => current(s).turns.at(-1)?.status !== "inProgress", "stopped");
  checks.push("explicit turn cancellation");
  // 未完成的目标必须先暂停并结算，清除后同一聊天仍能接受普通消息。
  const beforeGoal = await call("manage", { projectId: pid, threadId: tid, operation: "goal" });
  await call("manage", {
    projectId: pid,
    threadId: tid,
    operation: "goalCreate",
    objective: "后台持续执行",
    expectedRevision: beforeGoal.revision,
    maxTurns: 3,
  });
  await until(
    (s) => current(s).goals?.goal?.status === "active" && !!finishBackground,
    "goal running",
  );
  assert.equal(await button("清除目标").isDisabled(), true);
  await button("暂停目标").click();
  await until((s) => current(s).goals?.goal?.settling === true, "goal cancellation settling");
  assert.equal(await button("清除目标").isDisabled(), true);
  finishBackground();
  await until(
    (s) =>
      current(s).goals?.goal?.status === "paused" &&
      !current(s).goals.goal.settling &&
      current(s).turns.at(-1)?.status !== "inProgress",
    "goal paused and settled",
  );
  await button("清除目标").click();
  await until(
    (s) => current(s).goals?.goal === null && !s.projects[0].pending.length,
    "unfinished goal cleared",
  );
  await send("目标清除后发送普通消息");
  await until(
    (s) => current(s).turns.at(-1)?.status === "completed",
    "message after clearing goal",
  );
  assert.equal(await page.locator(".error-banner").count(), 0);
  assert.equal(current(await state()).goals.goal, null);
  checks.push(
    "unfinished Goal pause settles before clear; same chat accepts a normal message after clear",
  );
  await openPanel("文件");
  await page.getByRole("treeitem", { name: "hello.ts", exact: true }).click();
  await button("文件更多").click();
  await page.getByRole("menuitem", { name: "编辑代码", exact: true }).click();
  await page.getByLabel("编辑 hello.ts", { exact: true }).fill('export const hello = "edited";\n');
  await button("保存").click();
  await page.getByText("文件已保存", { exact: true }).waitFor();
  assert.match(await readFile(join(workspace, "hello.ts"), "utf8"), /edited/);
  await shot("03-files");
  await openPanel("改动");
  await shot("04-diff");
  await button("关闭面板").click();
  checks.push("native file edit and Git diff panel");
  await button("终端").click();
  const terminal = page.locator(".xterm-helper-textarea");
  await terminal.waitFor();
  await terminal.pressSequentially("printf 'AREAL_TERMINAL_OK\\n'");
  await terminal.press("Enter");
  let output = "";
  for (let i = 0; i < 100; i++) {
    const processes = await call("manage", {
      projectId: pid,
      threadId: tid,
      operation: "processes",
    });
    if (processes.data?.length) {
      const result = await call("manage", {
        projectId: pid,
        threadId: tid,
        operation: "processOutput",
        id: processes.data.at(-1).id,
        maxBytes: 4096,
      });
      output = (result.chunks ?? [])
        .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString())
        .join("");
      if (output.includes("AREAL_TERMINAL_OK")) break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(output, /AREAL_TERMINAL_OK/);
  await shot("05-terminal");
  await page
    .locator(".bottom-terminal")
    .getByRole("button", { name: "关闭面板", exact: true })
    .click();
  checks.push("real Runtime PTY with input/output");
  await openPanel("预览");
  await page.getByLabel("预览地址").fill(previewUrl);
  await page.getByLabel("预览地址").press("Enter");
  let previewEvidence;
  for (let i = 0; i < 100; i++) {
    previewEvidence = await app.evaluate(async ({ webContents }, url) => {
      const content = webContents.getAllWebContents().find((item) => item.getURL().startsWith(url));
      if (!content || content.isLoading()) return null;
      return {
        text: await content.executeJavaScript("document.body.innerText"),
        bridge: await content.executeJavaScript("typeof window.arealDesktop"),
        image: (await content.capturePage()).toPNG().toString("base64"),
      };
    }, previewUrl);
    if (previewEvidence?.text.includes("Project preview")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(previewEvidence?.text ?? "", /Project preview/);
  assert.equal(previewEvidence.bridge, "undefined");
  await writeFile(
    join(scratch, "06-native-preview.png"),
    Buffer.from(previewEvidence.image, "base64"),
  );
  frames.push("06-native-preview.png");
  await shot("06-preview");
  await button("关闭面板").click();
  checks.push("native embedded preview opens local workspace page");
  await button("设置").click();
  await button("手机连接").click();
  await shot("06-mobile-settings");
  await button("外观").click();
  await shot("06-settings");
  await button("返回应用").click();
  checks.push("settings navigation and appearance");
  await input().fill("保留未发送草稿");
  await call("send", { projectId: pid, threadId: tid, text: "后台持续执行" });
  await until(
    (s) => current(s).turns.at(-1)?.status === "inProgress" && finishBackground,
    "background started",
  );
  const turnCount = current(await state()).turns.length;
  const requestCount = received.length;
  const adapter = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
  await quit();
  process.kill(adapter.pid, 0);
  finishBackground();
  await launch();
  await until(
    (s) => s.projects[0]?.state?.connected && current(s)?.turns.at(-1)?.status === "completed",
    "recover after GUI exit",
  );
  assert.equal(current(await state()).turns.length, turnCount);
  assert.equal(received.length, requestCount);
  assert.equal(await input().textContent(), "保留未发送草稿");
  await shot("07-background-recovered");
  await button("任务资源").click();
  await page.getByRole("region", { name: "任务资源", exact: true }).getByRole("button", { name: `打开 ${doneChild.id} 子对话`, exact: true }).click();
  await page.locator(`[data-agent-conversation="${doneChild.id}"] [data-turn-status=completed]`).waitFor();
  assert.ok(await page.locator(`[data-agent-conversation="${doneChild.id}"] .tool-event`).count() > 0);
  assert.equal(await page.locator(`.agent-conversation-heading [data-agent-avatar="${doneChild.id}"]`).getAttribute("src"), await page.locator(`[data-testid=chat-view] [data-agent-avatar="${doneChild.id}"]`).getAttribute("src"));
  assert.equal(received.length, requestCount);
  await shot("07a-agent-restored");
  await button("关闭面板").click();
  checks.push("child messages/tools and local avatar identity restore after GUI restart without provider replay");
  checks.push(
    "running Core turn completes after GUI quit; reopen restores history/draft without replay",
  );
  await quit();
  process.kill(adapter.pid, "SIGTERM");
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(adapter.pid, 0);
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const transport = JSON.parse(
    await readFile(join(scratch, "core/subscription-transport.json"), "utf8"),
  );
  await launch();
  await until((s) => s.projects[0]?.state?.connected, "recover after adapter exit");
  const restored = JSON.parse(
    await readFile(join(scratch, "core/subscription-transport.json"), "utf8"),
  );
  assert.deepEqual(restored, transport);
  await send("适配器重连后继续");
  await until(
    (s) =>
      current(s).turns.length === turnCount + 1 && current(s).turns.at(-1)?.status === "completed",
    "continued after adapter exit",
  );
  const publicState = JSON.stringify(await state());
  assert.ok(!publicState.includes(transport.token));
  assert.ok(!publicState.includes(adapter.token));
  checks.push(
    "adapter restart reuses Core history and local capability; no tokens exposed in renderer snapshot",
  );
  const scheduled = await call("manage", {
    projectId: pid,
    operation: "taskCreate",
    mode: "scheduled",
    objective: "检查当前项目",
    interactionMode: "headless",
    schedule: { at: Math.floor(Date.now() / 1000) + 3 },
    maxTurns: 1,
    maxActiveSeconds: 60,
  });
  assert.ok(scheduled.id);
  await quit();
  await new Promise((r) => setTimeout(r, 4500));
  await launch();
  await until((s) => s.projects[0]?.state?.connected, "scheduled task reconnect");
  let task;
  for (let i = 0; i < 100; i++) {
    task = await call("manage", { projectId: pid, operation: "task", taskId: scheduled.id });
    if (task.runs?.length && !["running", "queued"].includes(task.runs.at(-1).status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(task.runs.length, 1);
  assert.ok(!["running", "queued"].includes(task.runs[0].status));
  await call("manage", {
    projectId: pid,
    operation: "taskCancel",
    taskId: task.id,
    expectedRevision: task.revision,
  });
  await button("执行任务").click();
  await shot("08-tasks");
  checks.push(
    "Core scheduled task triggers once while GUI is closed and run history survives reopening",
  );
  }
  assert.deepEqual(errors, []);
  passed = true;
  console.log(JSON.stringify({ passed, scratch, checks }));
} catch (error) {
  console.error("renderer errors", errors);
  console.error(await page?.locator("body").innerText());
  await shot("failure").catch(() => {});
  if (page) await writeFile(join(scratch, "failure-state.json"), JSON.stringify(await state(), null, 2)).catch(() => {});
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
