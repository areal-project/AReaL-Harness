import { makeTempDir } from "./support/temp.mjs";
import { closeSmokeApplication } from "./application-cleanup.mjs";
import { withSmokeDeadline } from "./smoke-deadline.mjs";
import assert from "node:assert/strict";

import { createRequire } from "node:module";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(gui, "app");
const require = createRequire(join(desktop, "package.json"));
const { _electron: electron } = require("playwright-core");
const { executeCore } = require(join(desktop, "src/core/core-process.cjs"));
const root = resolve(gui, "../..");
const binary = process.env.AREAL_GUI_EXECUTABLE
  ? resolve(dirname(process.env.AREAL_GUI_EXECUTABLE), "../Resources/areal-core/bin/areal")
  : process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
assert.ok(binary, "AREAL_CORE_BIN must point to the actual built Core");
const binarySha256AtStart = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
const scratch = await makeTempDir("areal-gui-");
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
const conversationStage2 = process.argv.includes("--conversation-stage2");
const conversationProduction = process.argv.includes("--conversation-production");
const settingsMode = process.argv.includes("--settings-stage1");
const desktopSettingsMode = process.argv.includes("--desktop-settings");
const i18nMode = process.argv.includes("--settings-i18n");
const nativeI18nMode = process.argv.includes("--native-dialog-i18n");
const hostMode = process.argv.includes("--conversation-host");
const motionMode = hostMode || process.argv.includes("--conversation-motion");
const journeyMode =
  desktopSettingsMode ||
  conversationProduction ||
  nativeI18nMode ||
  i18nMode ||
  conversationStage2 ||
  settingsMode ||
  motionMode ||
  process.argv.includes("--conversation-journey");
const journey = desktopSettingsMode
  ? (await import("./desktop-settings-smoke.mjs")).desktopSettingsSmoke(scratch, workspace)
  : nativeI18nMode
    ? (await import("./native-dialog-i18n.mjs")).nativeDialogI18n(scratch)
    : i18nMode
      ? (await import("./settings-i18n.mjs")).settingsI18n(scratch)
      : settingsMode
        ? (await import("./settings-stage1.mjs")).settingsStage1(scratch)
        : hostMode
          ? (await import("./conversation-host.mjs")).conversationHost(scratch, workspace)
          : journeyMode
            ? (await import("./conversation-journey.mjs")).conversationJourney(scratch, workspace, {
                motion: motionMode,
                stage2: conversationStage2,
                production: conversationProduction,
              })
            : null;
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
    last = msgs.findLastIndex(
      (m) =>
        m.role === "user" &&
        (!journey ||
          typeof m.content !== "string" ||
          !m.content.startsWith("AReaL runtime context (not a user request):")),
    ),
    content = msgs[last]?.content;
  const text =
    typeof content === "string" ? content : (content ?? []).map((x) => x.text ?? "").join("");
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  try {
    if (journey?.model(text, msgs, send, res)) return;
  } catch (error) {
    errors.push(error.stack);
    res.end("data: [DONE]\n\n");
    return;
  }
  if (text.includes("后台持续执行")) {
    send({ content: "后台开始。" });
    finishBackground = () => {
      send({ content: "后台完成。" });
      send({}, "stop");
      res.end("data: [DONE]\n\n");
    };
    return;
  }
  if (text.includes("启动子任务") && msgs.slice(last + 1).some((m) => m.role === "tool")) {
    send({ content: "父任务继续处理，子任务运行中。" });
    finishAgentParent = () => {
      send({ content: "父任务已完成。" });
      send({}, "stop");
      res.end("data: [DONE]\n\n");
    };
    return;
  }
  if (
    (text.includes("子任务完成") || text === "检查当前项目") &&
    !msgs.slice(last + 1).some((m) => m.role === "tool")
  ) {
    send({
      tool_calls: [
        {
          index: 0,
          id: "child-read",
          type: "function",
          function: {
            name: "fs_read",
            arguments: JSON.stringify({ path: "workspace://repo/hello.ts" }),
          },
        },
      ],
    });
    send({}, "tool_calls");
    res.end("data: [DONE]\n\n");
    return;
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
      tool_calls: ["子任务完成", "子任务等待停止", "子任务完成 · 检查参考来源"].map(
        (prompt, index) => ({
          index,
          id: `child-${index}`,
          type: "function",
          function: {
            name: "agent_spawn",
            arguments: JSON.stringify({ prompt, intent: "inspect", delivery: "report" }),
          },
        }),
      ),
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
// 本地 SSE fixture 必须直连；保留宿主已有排除项并同步两种大小写。
const noProxy = [
  ...new Set(
    [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1,localhost,::1"]
      .filter(Boolean)
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  ),
].join(",");
const env = {
  ...process.env,
  NO_PROXY: noProxy,
  no_proxy: noProxy,
  AREAL_GUI: "workbench",
  AREAL_BACKEND: "areal",
  AREAL_CORE_BIN: binary,
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user-home"),
  AREAL_HARNESS_HOME: join(scratch, "runtime"),
  AREAL_CORE_CONFIG: config,
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "services"),
};
delete env.AREAL_CORE_WORKSPACE;
if (process.env.AREAL_GUI_EXECUTABLE) delete env.AREAL_CORE_BIN;
let app,
  page,
  passed = false,
  failure = null;
const errors = [],
  frames = [],
  checks = [];
const button = (name) => page.getByRole("button", { name, exact: true });
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = (snapshot) => snapshot.projects.find((p) => p.root === workspace && !p.projectless);
async function call(name, params) {
  const result = await page.evaluate(
    async ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  if (!result.ok) throw Error(result.error.message);
  return result.value;
}
// Return the observed desktop snapshot, never the predicate's value.
async function waitForSnapshot(predicate, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const s = await state();
    if (await predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error("Timeout: " + label);
}
// 服务检查与清理使用产品原生启动入口，避免 Node 直接执行本地 Mach-O 被系统拒绝。
const services = async () =>
  JSON.parse(
    (await executeCore(binary, ["service", "list", "--json"], { env, timeout: 20000 })).stdout,
  );
async function waitForApplicationStop(records) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const current = await services();
    const settled = records.every((original) => {
      const record = current.find((value) => value.serviceId === original.serviceId);
      return (
        record?.generation === original.generation &&
        record.state === "stopped" &&
        [original.hostPid, original.corePid]
          .filter((pid) => Number.isSafeInteger(pid) && pid > 1)
          .every((pid) => {
            try {
              process.kill(pid, 0);
              return false;
            } catch (error) {
              if (error.code === "ESRCH") return true;
              throw error;
            }
          })
      );
    });
    if (settled) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Application exit did not stop its original service generations and processes");
}
async function waitForPopupMotion(selector) {
  // Base UI 先移除起始样式，之后才创建过渡；此前 getAnimations() 可能为空。
  await page.locator(`${selector}:not([data-starting-style]):not([data-ending-style])`).waitFor();
  await page.locator(selector).evaluate(async (el) => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await Promise.all(el.getAnimations().map((animation) => animation.finished));
  });
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
  if (journey) await mkdir(join(scratch, "video"), { recursive: true });
  app = await electron.launch({
    ...(journey && !motionMode
      ? { recordVideo: { dir: join(scratch, "video"), size: { width: 1509, height: 949 } } }
      : {}),
    executablePath: process.env.AREAL_GUI_EXECUTABLE || require("electron"),
    // 原生恢复弹窗使用 bundle 级状态，独立 userData 仍会受之前崩溃影响；只在夹具忽略旧窗口。
    args: [
      ...(process.env.AREAL_GUI_EXECUTABLE
        ? []
        : [
            desktop,
            ...(hostMode && process.env.AREAL_E3_CDP_PORT
              ? ["--remote-debugging-port=" + process.env.AREAL_E3_CDP_PORT]
              : []),
          ]),
      ...(process.platform === "darwin" ? ["-ApplePersistenceIgnoreState", "YES"] : []),
    ],
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
  // 本专项统计执行请求；提示预测由独立专项验收，避免辅助请求混入不重放断言。
  const preferencesChanged = await page.evaluate(() => {
    const key = "areal-gui:application-preferences";
    const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (preferences.nextPromptSuggestions === false) return false;
    localStorage.setItem(key, JSON.stringify({ ...preferences, nextPromptSuggestions: false }));
    return true;
  });
  if (preferencesChanged) {
    await page.reload();
    await page.locator("[data-testid=areal-workbench]").waitFor({ timeout: 120000 });
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
}
async function openPanel(name) {
  if (await button("返回工作区").isVisible()) await button("返回工作区").click();
  if (name === "终端") {
    await page.keyboard.press("Control+Backquote");
    return;
  }
  await button("任务操作").click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
async function quit() {
  if (!app) return;
  const current = app;
  try {
    try {
      await withSmokeDeadline(
        "quit confirmation fixture",
        () =>
          current.evaluate(({ dialog }) => {
            dialog.showMessageBox = async () => ({ response: 1 });
          }),
        5000,
      );
    } finally {
      // 退出先等待已受理操作（20s），再核查停服和原进程退出；不能共用单阶段 20s 预算。
      await closeSmokeApplication(current, 60000);
    }
  } finally {
    app = null;
  }
}
async function hideWindow() {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await waitForSnapshot(
    async () =>
      !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())),
    "window hidden after owned activity settles",
  );
}
async function revealWindow() {
  await app.evaluate(({ app }) => app.emit("activate"));
  await waitForSnapshot(
    async () =>
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    "window visible after activate",
  );
}
console.log("GUI evidence:", scratch);
console.log("Core binary SHA-256 at start:", binarySha256AtStart);
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
  await waitForSnapshot((s) => project(s)?.state?.connected, "project ready");
  const pid = project(await state()).id;
  const selectFixtureProfile = async () => {
    await page.waitForFunction((id) => {
      const workbench = document.querySelector('[data-testid="areal-workbench"]');
      return workbench?.dataset.projectId === id && !workbench.dataset.threadId;
    }, pid);
    assert(project(await state()).profiles.some((p) => p.id === "standard" && p.revision === "v1"));
    await page.evaluate((id) => {
      const key = `areal-gui:draft:${id}:new`;
      localStorage.setItem(`${key}:profile`, JSON.stringify({ id: "standard", revision: "v1" }));
      window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key }));
    }, pid);
  };
  await selectFixtureProfile();
  const input = () => page.locator("[data-testid=chat-input]");
  const turnCountOf = (s) =>
    Object.values(project(s).state.threads).reduce((n, t) => n + (t.turns?.length ?? 0), 0);
  const send = async (text) => {
    const count = turnCountOf(await state());
    await input().fill(text);
    await button("发送").click();
    await waitForSnapshot((s) => turnCountOf(s) > count, "turn admission");
  };
  if (journey) {
    await journey.run({
      app: () => app,
      page: () => page,
      state,
      call,
      until: waitForSnapshot,
      button,
      launch,
      quit,
      received,
      checks,
      previewUrl,
    });
  } else {
    // 通用提示入口是短暂 toast；后续真实发送不应把它升级为常驻错误。
    await page.evaluate(() =>
      document.dispatchEvent(
        new CustomEvent("areal:toast", {
          detail: "thread is busy or the target turn is stale",
        }),
      ),
    );
    const toast = page.getByTestId("toast");
    await toast.filter({ hasText: "thread is busy or the target turn is stale" }).waitFor();
    await send("检查当前项目");
    await waitForSnapshot(
      (s) =>
        Object.values(project(s).state.threads).some(
          (t) => t.turns?.at(-1)?.status === "completed",
        ),
      "first send",
    );
    await toast.waitFor({ state: "hidden" });
    assert.equal(
      await page.locator('[data-testid="feedback-notice"][data-tone="error"]').count(),
      0,
    );
    const tid = await page.locator("[data-testid=areal-workbench]").getAttribute("data-thread-id");
    assert.equal(project(await state()).configurations[tid].profile.id, "standard");
    assert.equal(project(await state()).configurations[tid].profile.revision, "v1");
    const current = (s) => project(s).state.threads[tid];
    assert.ok(tid);
    await shot("02-conversation");
    checks.push("sandboxed Electron; project picker; first send; real Core/Runtime and local SSE");
    checks.push(
      "transient toast clears without becoming persistent feedback after real Core acceptance",
    );
    // 子对话只改变侧面板；真实子 Thread、工具记录与停止结果由 Core 提供。
    const reference = await page.evaluate(
      async ({ pid }) => {
        const response = await window.arealDesktop.command("media", {
          projectId: pid,
          threadId: document.querySelector("[data-testid=areal-workbench]").dataset.threadId,
          operation: "upload",
          mime: "image/png",
          bytes: Uint8Array.from(
            atob(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
            ),
            (char) => char.charCodeAt(0),
          ),
        });
        if (!response.ok) throw Error(response.error.message);
        return response.value;
      },
      { pid },
    );
    await call("send", {
      projectId: pid,
      threadId: tid,
      text: "启动子任务",
      attachments: [{ type: "image", url: reference.uri }],
    });
    await waitForSnapshot(
      async () =>
        (
          await call("manage", {
            projectId: pid,
            parentThreadId: tid,
            operation: "agents",
            limit: 30,
          })
        ).data.length === 3,
      "three real children",
    );
    const children = (
      await call("manage", { projectId: pid, parentThreadId: tid, operation: "agents", limit: 30 })
    ).data;
    const doneChild = children.find((t) => t.preview === "子任务完成");
    const liveChild = children.find((t) => t.preview === "子任务等待停止");
    assert.ok(doneChild && liveChild);
    await waitForSnapshot(async () => {
      const results = await call("manage", {
        projectId: pid,
        parentThreadId: tid,
        operation: "agentWait",
        threadIds: children.map((child) => child.id),
        timeoutMs: 0,
      });
      return (
        results.data.filter((result) => result.status === "completed").length === 2 &&
        results.data.find((result) => result.threadId === liveChild.id)?.status === "inProgress"
      );
    }, "two completed children and one live child");
    const backgroundProcess = await call("manage", {
      projectId: pid,
      threadId: tid,
      operation: "processStart",
      requestId: randomUUID(),
      argv: ["/bin/sh", "-c", "printf 'Resource process ready\\n'; sleep 300"],
      cwd: "workspace://repo",
      lifetime: "thread",
      tty: false,
    });
    assert.ok(backgroundProcess.id);
    const backgroundState = await call("manage", {
      projectId: pid,
      threadId: tid,
      operation: "process",
      id: backgroundProcess.id,
    });
    assert.equal(backgroundState.process.state, "running", JSON.stringify(backgroundState));
    assert.ok(
      backgroundState.process.processId,
      "a start receipt alone does not prove Runtime execution",
    );
    const mainWidth = await page
      .locator("[data-testid=chat-view]")
      .evaluate((el) => el.getBoundingClientRect().width);
    await button("任务资源").click();
    const resources = page.getByRole("complementary", { name: "任务上下文", exact: true });
    await resources.getByRole("button", { name: /^查看全部子代理（3） / }).waitFor();
    await resources.getByRole("button").filter({ hasText: "Changes" }).waitFor();
    await resources.getByRole("heading", { name: "后台进程", exact: false }).waitFor();
    const agentSummary = resources.getByRole("region", { name: "子智能体", exact: true });
    await agentSummary.locator(`[data-agent-avatar="${liveChild.id}"]`).waitFor();
    await agentSummary.getByText("2 个已完成", { exact: true }).waitFor();
    // 摘要头像优先展示仍运行的子任务，总数由“查看全部”入口表达。
    assert.equal(await agentSummary.locator("[data-agent-avatar]").count(), 1);
    assert.equal(await agentSummary.locator(`[data-agent-avatar="${doneChild.id}"]`).count(), 0);
    assert.equal(
      await page
        .locator("[data-testid=chat-view]")
        .evaluate((el) => el.getBoundingClientRect().width),
      mainWidth,
    );
    // 等待入场缩放结束再检查最终宽度，避免把动画中的 98% 尺寸当成布局回归。
    await waitForPopupMotion(".task-resources-popup");
    assert.equal(
      await page
        .locator(".task-resources-popup")
        .evaluate((el) => el.getBoundingClientRect().width),
      268, // Default 12px UI typography and the shared inline-spacing token.
    );
    await page.keyboard.press("Escape");
    await resources.waitFor({ state: "hidden" });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "任务资源",
    );
    assert.equal(await button("任务资源").evaluate((el) => el === document.activeElement), true);
    await button("任务资源").click();
    await resources.getByRole("button", { name: "预览图片 消息图片", exact: true }).waitFor();
    await resources.getByRole("button", { name: "预览图片 消息图片", exact: true }).click();
    await page.getByRole("button", { name: "关闭图片预览", exact: true }).waitFor();
    await page.waitForFunction(() =>
      document.activeElement?.closest('[data-slot="dialog-content"]'),
    );
    await waitForPopupMotion('[data-slot="dialog-content"]');
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "关闭图片预览", exact: true })
      .waitFor({ state: "hidden" });
    await resources.waitFor();
    await resources.getByRole("button").filter({ hasText: "Changes" }).waitFor();
    const changes = resources.getByRole("button").filter({ hasText: "Changes" });
    assert.match(await changes.getAttribute("aria-label"), /1\s*个文件/);
    assert.match(await changes.innerText(), /\+1/);
    assert.match(await changes.innerText(), /−1/);
    await resources.getByRole("heading", { name: "workspace", exact: true }).click();
    await waitForPopupMotion(".task-resources-popup");
    await writeFile(
      join(scratch, "resource-layout.json"),
      JSON.stringify(
        await page.locator(".task-resources-popup").evaluate((el) => ({
          width: el.getBoundingClientRect().width,
          background: getComputedStyle(el).backgroundColor,
          backgroundImage: getComputedStyle(el).backgroundImage,
          token: getComputedStyle(el).getPropertyValue("--color-popover"),
          menuToken: getComputedStyle(el).getPropertyValue("--color-menu"),
          pageBackground: getComputedStyle(el).getPropertyValue("--color-background"),
          headings: [...el.querySelectorAll("h3")].map((h) => ({
            text: h.textContent,
            weight: getComputedStyle(h).fontWeight,
          })),
        })),
        null,
        2,
      ),
    );
    await shot("02r-task-resources");
    await page
      .locator(".task-resources-popup")
      .screenshot({ path: join(scratch, "02r-task-resources-crop.png") });
    const liveAvatar = await resources
      .locator(`[data-agent-avatar="${liveChild.id}"]`)
      .getAttribute("src");
    assert.ok(liveAvatar.startsWith("data:image/svg+xml"));
    const liveAgentCard = page
      .locator("[data-testid=chat-view]")
      .getByRole("button", { name: `打开 ${liveChild.id} 子对话`, exact: true });
    assert.equal(await liveAgentCard.count(), 1);
    assert.equal(await liveAgentCard.locator(".agent-spawn-title").innerText(), "子任务等待停止");
    await resources.getByRole("button", { name: /^查看全部子代理（3） / }).click();
    const agentsPanel = page.getByRole("region", { name: "子代理面板", exact: true });
    await agentsPanel.locator(`[data-agent-id="${liveChild.id}"]`).waitFor();
    assert.deepEqual(
      (
        await agentsPanel
          .locator("[data-agent-id]")
          .evaluateAll((rows) => rows.map((row) => row.dataset.agentId))
      ).sort(),
      children.map((child) => child.id).sort(),
    );
    await agentsPanel.locator(`[data-agent-id="${liveChild.id}"]`).click();
    await page
      .locator(`[data-agent-conversation="${liveChild.id}"] [data-turn-status=inProgress]`)
      .waitFor();
    assert.equal(
      await page.locator("[data-testid=areal-workbench]").getAttribute("data-thread-id"),
      tid,
    );
    assert.equal(await input().count(), 1);
    await input().fill("主对话草稿保持");
    assert.equal(
      await agentsPanel.locator(`header [data-agent-avatar="${liveChild.id}"]`).getAttribute("src"),
      liveAvatar,
    );
    assert.equal(
      await page
        .locator(`[data-testid=chat-view] [data-agent-avatar="${liveChild.id}"]`)
        .getAttribute("src"),
      liveAvatar,
    );
    await shot("02a-agent-running");
    await agentsPanel.getByRole("button", { name: "关闭子代理面板", exact: true }).click();
    await resources.waitFor();
    await page.keyboard.press("Escape");
    await resources.waitFor({ state: "hidden" });
    const afterClose = await call("manage", {
      projectId: pid,
      parentThreadId: tid,
      operation: "agentWait",
      threadIds: [liveChild.id],
      timeoutMs: 0,
    });
    assert.equal(afterClose.data[0].status, "inProgress");
    await page
      .locator("[data-testid=chat-view]")
      .getByRole("button", { name: `打开 ${liveChild.id} 子对话`, exact: true })
      .click();
    await page
      .locator(`[data-agent-conversation="${liveChild.id}"] [data-turn-status=inProgress]`)
      .waitFor();
    await button("任务资源").click();
    await resources.getByRole("button").filter({ hasText: "Changes" }).click();
    assert.equal(
      await page.locator("[data-testid=workspace-review]").getAttribute("data-review-source"),
      "git",
    );
    await page.getByRole("button", { name: "改动范围", exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "改动范围", exact: true }).innerText(),
      "未暂存的更改",
    );
    await button("任务资源").click();
    await resources.getByRole("button", { name: /^查看全部子代理（3） / }).click();
    await agentsPanel.locator(`[data-agent-id="${doneChild.id}"]`).click();
    await page
      .locator(`[data-agent-conversation="${doneChild.id}"] [data-turn-status=completed]`)
      .waitFor();
    assert.equal(await input().innerText(), "主对话草稿保持");
    const donePane = page.locator(`[data-agent-conversation="${doneChild.id}"]`);
    const doneAvatar = await agentsPanel
      .locator(`header [data-agent-avatar="${doneChild.id}"]`)
      .getAttribute("src");
    assert.ok(doneAvatar.startsWith("data:image/svg+xml"));
    assert.equal(await donePane.locator(".user-message").count(), 1);
    await donePane.locator(".turn-progress-summary").click();
    await donePane.locator(".tool-event").first().waitFor();
    await donePane.getByRole("button", { name: "查看工具原始记录", exact: true }).click();
    await donePane.getByLabel("工具结果", { exact: true }).waitFor();
    await shot("02b-agent-completed");
    await agentsPanel.getByRole("button", { name: "关闭子代理面板", exact: true }).click();
    await resources.waitFor();
    await page.keyboard.press("Escape");
    await resources.waitFor({ state: "hidden" });
    await liveAgentCard.click();
    await call("stop", {
      projectId: pid,
      threadId: liveChild.id,
      turnId: project(await state()).state.threads[liveChild.id].turns.at(-1).id,
      requestId: randomUUID(),
    });
    await page
      .locator(`[data-agent-conversation="${liveChild.id}"] [data-turn-status=interrupted]`)
      .waitFor();
    await button("新聊天").click();
    assert.equal(await page.locator("[data-agent-conversation]").count(), 0);
    await page.locator(`#areal-sidebar [data-thread-id="${tid}"]`).first().click();
    await page
      .locator(`[data-agent-conversation="${liveChild.id}"] [data-turn-status=interrupted]`)
      .waitFor();
    assert.equal(await input().innerText(), "主对话草稿保持");
    assert.ok(finishAgentParent);
    finishAgentParent();
    await waitForSnapshot(
      (s) => current(s).turns.at(-1)?.status === "completed",
      "parent completes after child stop",
    );
    await shot("02c-agent-interrupted");
    await button("关闭面板").click();
    await input().fill("");
    await call("manage", {
      projectId: pid,
      threadId: tid,
      operation: "processTerminate",
      id: backgroundProcess.id,
    });
    checks.push(
      "Core children: compact 268px four-group resources, Escape/focus, running/completed/interrupted side conversations, switching/closing preserve parent and composer draft",
    );
    const executionList = await call("manage", {
      projectId: pid,
      parentThreadId: tid,
      operation: "executions",
      offset: 0,
      limit: 50,
    });
    const execution = executionList.data.find((item) => item.threadId === doneChild.id);
    assert.ok(execution?.executionId);
    assert.equal(execution.settled, true);
    assert.equal(execution.verification.status, "notRun");
    assert.equal(execution.delivery.status, "notRequired");
    await openPanel("子任务");
    const executionCard = page.getByTestId(`execution-${execution.executionId}`);
    await executionCard.waitFor();
    assert.match(await executionCard.innerText(), /未运行检查/);
    assert.match(await executionCard.innerText(), /报告交付/);
    assert.equal(await button("创建子任务").isVisible(), false);
    await shot("02-subtask-delivery");
    await button("关闭面板").click();
    checks.push(
      "unified agent delegation; one subtask panel; verification and delivery stay distinct",
    );
    // 已有完整验收通过后，视觉行文修正只重跑其真实资源/事件路径。
    if (!process.env.AREAL_GUI_RESOURCE_SMOKE_ONLY) {
      await send("审批写入");
      await button("允许一次").click();
      await waitForSnapshot(
        (s) => current(s).turns.at(-1)?.status === "completed",
        "approved write",
      );
      assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), "approved once");
      await send("需要问答");
      await page.getByRole("radio", { name: /最小修改/ }).click();
      await page
        .getByRole("region", { name: "需要你的回答", exact: true })
        .getByRole("button", { name: "发送", exact: true })
        .click();
      await waitForSnapshot(
        (s) => current(s).turns.at(-1)?.status === "completed",
        "question resumed",
      );
      checks.push("tool approval executes filesystem write; question reply resumes same turn");
      await send("等待停止");
      await waitForSnapshot((s) => current(s).turns.at(-1)?.status === "inProgress", "running");
      await call("stop", {
        projectId: pid,
        threadId: tid,
        turnId: current(await state()).turns.at(-1).id,
        requestId: randomUUID(),
      });
      await waitForSnapshot((s) => current(s).turns.at(-1)?.status !== "inProgress", "stopped");
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
      await waitForSnapshot(
        (s) => current(s).goals?.goal?.status === "active" && !!finishBackground,
        "goal running",
      );
      assert.equal(await button("清除目标").isDisabled(), true);
      await button("暂停目标").click();
      await waitForSnapshot(
        (s) => current(s).goals?.goal?.settling === true,
        "goal cancellation settling",
      );
      assert.equal(await button("清除目标").isDisabled(), true);
      finishBackground();
      await waitForSnapshot(
        (s) =>
          current(s).goals?.goal?.status === "paused" &&
          !current(s).goals.goal.settling &&
          current(s).turns.at(-1)?.status !== "inProgress",
        "goal paused and settled",
      );
      await button("清除目标").click();
      await waitForSnapshot(
        (s) => current(s).goals?.goal === null && !project(s).pending.length,
        "unfinished goal cleared",
      );
      await send("目标清除后发送普通消息");
      await waitForSnapshot(
        (s) => current(s).turns.at(-1)?.status === "completed",
        "message after clearing goal",
      );
      assert.equal(
        await page.locator('[data-testid="feedback-notice"][data-tone="error"]').count(),
        0,
      );
      assert.equal(current(await state()).goals.goal, null);
      checks.push(
        "unfinished Goal pause settles before clear; same chat accepts a normal message after clear",
      );
      await openPanel("文件");
      await page.getByRole("treeitem", { name: "hello.ts", exact: true }).click();
      await button("文件更多").click();
      await page.getByRole("menuitem", { name: "编辑代码", exact: true }).click();
      await page
        .getByLabel("编辑 hello.ts", { exact: true })
        .fill('export const hello = "edited";\n');
      await button("保存").click();
      await page.getByText("文件已保存", { exact: true }).waitFor();
      assert.match(await readFile(join(workspace, "hello.ts"), "utf8"), /edited/);
      await shot("03-files");
      await openPanel("改动");
      await shot("04-diff");
      await button("关闭面板").click();
      checks.push("native file edit and Git diff panel");
      await openPanel("终端");
      const terminal = page.locator(".xterm-helper-textarea");
      await page.locator(".terminal-pane .xterm-screen").waitFor();
      await terminal.waitFor({ state: "attached" });
      let terminalProcess;
      await waitForSnapshot(async () => {
        const records = await call("manage", {
          projectId: pid,
          threadId: tid,
          operation: "processes",
        });
        const process = records.data.find((item) => item.id !== backgroundProcess.id);
        if (process?.state === "failed") assert.fail(JSON.stringify(process));
        if (process?.state !== "running" || !process.processId) return false;
        terminalProcess = process;
        return true;
      }, "UI terminal Runtime process running");
      await terminal.focus();
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
            id: terminalProcess.id,
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
      await button("关闭面板").click();
      checks.push("real Runtime PTY with input/output");
      await app.evaluate(({ dialog }, origin) => {
        const showMessageBox = dialog.showMessageBox.bind(dialog);
        dialog.showMessageBox = async (...args) => {
          const options = args.at(-1);
          if (
            options.title === "允许本地开发站点" &&
            options.message === `允许此浏览工作区访问 ${origin}？` &&
            JSON.stringify(options.buttons) === JSON.stringify(["取消", "仅此工作区允许"])
          ) {
            return { response: 1 };
          }
          return showMessageBox(...args);
        };
      }, new URL(previewUrl).origin);
      await openPanel("预览");
      await page.getByLabel("预览地址").fill(previewUrl);
      await app.evaluate(({ app, BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window.isMinimized()) window.restore();
        window.show();
        app.focus({ steal: true });
        window.focus();
      });
      let previewWindowState = null;
      try {
        await waitForSnapshot(async () => {
          previewWindowState = await app.evaluate(({ app, BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0];
            return {
              id: window.id,
              visible: window.isVisible(),
              minimized: window.isMinimized(),
              focused: window.isFocused(),
              focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
              appHidden: app.isHidden(),
            };
          });
          return (
            previewWindowState.visible &&
            !previewWindowState.minimized &&
            previewWindowState.focused
          );
        }, "visible focused window for development-site consent");
      } finally {
        await writeFile(
          join(scratch, "preview-window-state.json"),
          JSON.stringify(previewWindowState, null, 2),
        );
      }
      await page.getByLabel("预览地址").press("Enter");
      let previewEvidence;
      for (let i = 0; i < 100; i++) {
        previewEvidence = await app.evaluate(async ({ webContents }, url) => {
          const content = webContents
            .getAllWebContents()
            .find((item) => item.getURL().startsWith(url));
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
      // Turn 可先进入 inProgress；必须等本次请求抵达，不能复用之前 Goal 的完成回调。
      finishBackground = undefined;
      await call("send", { projectId: pid, threadId: tid, text: "后台持续执行" });
      await waitForSnapshot(
        (s) => current(s).turns.at(-1)?.status === "inProgress" && finishBackground,
        "background started",
      );
      const turnCount = current(await state()).turns.length;
      const requestCount = received.length;
      const adapter = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
      const applicationPid = app.process().pid;
      await hideWindow();
      process.kill(applicationPid, 0);
      process.kill(adapter.pid, 0);
      finishBackground();
      await revealWindow();
      await waitForSnapshot(
        (s) => project(s)?.state?.connected && current(s)?.turns.at(-1)?.status === "completed",
        "recover after window close",
      );
      assert.equal(current(await state()).turns.length, turnCount);
      assert.equal(received.length, requestCount);
      assert.equal(await input().textContent(), "保留未发送草稿");
      await shot("07-background-recovered");
      await button("任务资源").click();
      await resources.getByRole("button", { name: /^查看全部子代理（3） / }).click();
      await agentsPanel.locator(`[data-agent-id="${doneChild.id}"]`).click();
      await page
        .locator(`[data-agent-conversation="${doneChild.id}"] [data-turn-status=completed]`)
        .waitFor();
      // 重新挂载的已完成过程组默认收起，先按用户操作展开，再核验恢复的工具记录。
      const restoredProgress = page.locator(
        `[data-agent-conversation="${doneChild.id}"] .turn-progress-summary`,
      );
      if ((await restoredProgress.getAttribute("aria-expanded")) === "false")
        await restoredProgress.click();
      assert.ok(
        (await page.locator(`[data-agent-conversation="${doneChild.id}"] .tool-event`).count()) > 0,
      );
      assert.equal(
        await agentsPanel
          .locator(`header [data-agent-avatar="${doneChild.id}"]`)
          .getAttribute("src"),
        doneAvatar,
      );
      assert.equal(received.length, requestCount);
      await shot("07a-agent-restored");
      await button("关闭面板").click();
      checks.push(
        "child messages/tools and local avatar identity restore after window reopen without provider replay",
      );
      checks.push(
        "window close preserves the application and running Core turn; reopen restores history/draft without replay",
      );
      const transport = JSON.parse(
        await readFile(join(scratch, "core/subscription-transport.json"), "utf8"),
      );
      process.kill(adapter.pid, "SIGKILL");
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(adapter.pid, 0);
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.throws(
        () => process.kill(adapter.pid, 0),
        (error) => error.code === "ESRCH",
        "the fault-injected adapter has exited",
      );
      await waitForSnapshot(
        (s) => s.connection?.state !== "ready",
        "observe adapter disconnection",
      );
      await call("connectService", {});
      await waitForSnapshot(async (s) => {
        const next = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
        return next.pid !== adapter.pid && project(s)?.state?.connected;
      }, "recover after adapter exit");
      const restored = JSON.parse(
        await readFile(join(scratch, "core/subscription-transport.json"), "utf8"),
      );
      assert.deepEqual(restored, transport);
      await send("适配器重连后继续");
      await waitForSnapshot(
        (s) =>
          current(s).turns.length === turnCount + 1 &&
          current(s).turns.at(-1)?.status === "completed",
        "continued after adapter exit",
      );
      const publicState = JSON.stringify(await state());
      assert.ok(!publicState.includes(transport.token));
      assert.ok(!publicState.includes(adapter.token));
      checks.push(
        "adapter restart reuses Core history and local capability; no tokens exposed in renderer snapshot",
      );
      const beforeQuit = (await services()).filter(
        (record) => record.workspace === workspace && record.state !== "stopped",
      );
      assert.ok(beforeQuit.length > 0, "cold reopen starts from a real live GUI service");
      const requestsBeforeQuit = received.length;
      await input().fill("冷启动保留草稿");
      await quit();
      await waitForApplicationStop(beforeQuit);
      await launch();
      await waitForSnapshot(
        (s) => project(s)?.state?.connected && current(s)?.turns.length === turnCount + 1,
        "cold application reopen restores history",
      );
      assert.equal(
        received.length,
        requestsBeforeQuit,
        "cold application reopen never replays model requests",
      );
      assert.equal(await input().textContent(), "冷启动保留草稿");
      checks.push(
        "application exit stops its original service generations and processes; cold reopen restores history and draft without replay",
      );
      const scheduledOwner = await call("projectless", {
        operation: "prepare",
        requestId: randomUUID(),
      });
      await writeFile(
        join(scheduledOwner.cwd, "hello.ts"),
        await readFile(join(workspace, "hello.ts")),
      );
      const scheduled = await call("manage", {
        projectId: scheduledOwner.projectId,
        operation: "taskCreate",
        mode: "scheduled",
        objective: "检查当前项目",
        interactionMode: "interactive",
        schedule: { at: Math.floor(Date.now() / 1000) + 3 },
        maxTurns: 1,
        maxActiveSeconds: 60,
      });
      assert.ok(scheduled.id);
      await hideWindow();
      await new Promise((r) => setTimeout(r, 4500));
      await revealWindow();
      await waitForSnapshot((s) => project(s)?.state?.connected, "scheduled task reconnect");
      let task;
      for (let i = 0; i < 100; i++) {
        task = await call("manage", {
          projectId: scheduledOwner.projectId,
          operation: "task",
          taskId: scheduled.id,
        });
        if (task.runs?.length && !["running", "queued"].includes(task.runs.at(-1).status)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(task.runs.length, 1);
      assert.ok(!["running", "queued"].includes(task.runs[0].status));
      await call("manage", {
        projectId: scheduledOwner.projectId,
        operation: "taskCancel",
        taskId: task.id,
        expectedRevision: task.revision,
      });
      await button("定时任务").click();
      await shot("08-tasks");
      checks.push("window close preserves one scheduled execution and its run history");
    }
  }
  assert.deepEqual(errors, []);
  passed = true;
  console.log(JSON.stringify({ passed, scratch, checks }));
} catch (error) {
  failure = error.stack || error.message;
  await writeFile(join(scratch, "failure.txt"), failure);
  console.error("GUI failure:", failure);
  console.error("renderer errors", errors);
  console.error(await page?.locator("body").innerText());
  await shot("failure").catch(() => {});
  if (page)
    await writeFile(
      join(scratch, "failure-state.json"),
      JSON.stringify(await state(), null, 2),
    ).catch(() => {});
  throw error;
} finally {
  try {
    await quit();
    await waitForApplicationStop(await services());
    const metadata = await readFile(join(scratch, "core/service.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (metadata)
      assert.throws(
        () => process.kill(metadata.pid, 0),
        (error) => error.code === "ESRCH",
        "the GUI adapter exits with its application",
      );
    checks.push("application lifecycle cleanup leaves no live adapter or original Core service");
  } catch (error) {
    console.error("Adapter fixture cleanup:", error.message);
    if (passed) {
      passed = false;
      process.exitCode = 1;
      errors.push(`Explicit safe stop failed: ${error.message}`);
    }
    // 仅清理本次隔离 home 中的服务；失败不遗留模型任务或后台进程。
    try {
      const instances = await services();
      for (const instance of instances)
        if (instance.state !== "stopped") {
          await executeCore(
            binary,
            ["service", "stop", "--instance", instance.serviceId, "--cancel", "--json"],
            { env, timeout: 120000 },
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
  const diff = execFileSync("git", ["diff", "--binary", "HEAD"], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
        sourceFiles,
        binarySha256AtStart,
        binarySha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
        diffSha256: createHash("sha256").update(diff).digest("hex"),
        binary,
        controller: {
          node: process.version,
          executable: process.execPath,
          sha256: createHash("sha256")
            .update(await readFile(process.execPath))
            .digest("hex"),
        },
        platform: process.platform,
        arch: process.arch,
        runtime: "real Electron + real Rust Core/Runtime + deterministic local HTTP/SSE model",
        nativeDialogs: nativeI18nMode
          ? "initial project picker injected; archive/save/directory dialog options captured and canceled; OS appearance not verified"
          : "project picker and archive/quit confirmations injected",
        scenario: desktopSettingsMode
          ? "desktop-settings"
          : conversationProduction
            ? "conversation-production"
            : nativeI18nMode
              ? "native-dialog-i18n"
              : i18nMode
                ? "settings-i18n"
                : conversationStage2
                  ? "conversation-stage2"
                  : settingsMode
                    ? "settings-stage1"
                    : hostMode
                      ? "conversation-host"
                      : motionMode
                        ? "conversation-motion"
                        : journey
                          ? "conversation-journey"
                          : "migration",
        scratch,
        frames: journey ? journey.frames() : frames,
        journeyEvents: journey && !nativeI18nMode ? "journey-events.json" : null,
        checks,
        errors,
        failure,
      },
      null,
      2,
    ),
  );
}
