// 高频操作基线：在真实 Electron、后台和 Core 上走三条旅程，每步截图并跑 ux-checks 的 5 项检查。
// 旅程 1 没配模型去配置；旅程 3 打开项目、发消息、审批时继续排队；旅程 4 右上角摘要。
// 只有外部模型是本地假模型，状态全在临时目录里，不碰本机真实数据。
// 先构建 Core（cargo build -p areal-cli）和界面（pnpm --dir clients/gui build），再运行：
//   node clients/gui/scripts/ux-journeys.mjs [--out <截图目录>]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./support/temp.mjs";
import { expectFeedback, inspectPage } from "./ux-checks.mjs";

const gui = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const outIndex = process.argv.indexOf("--out");
const scratch = await makeTempDir("areal-ux-");
const shots = resolve(outIndex > 0 ? process.argv[outIndex + 1] : join(tmpdir(), "areal-ux-shots"));
await mkdir(shots, { recursive: true });
const results = [];
const record = (result) => {
  results.push(result);
  if (result.problems.length) console.log(`✗ ${result.step}: ${result.problems.join("；")}`);
  else console.log(`✓ ${result.step}`);
};

// 假模型：读文件 → 要联网的命令（触发审批）→ 最终回答。
const reply = "## 已添加 clamp\n\n在 `src/math.ts` 加了 `clamp`，并补了边界测试。";
const model = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    const request = JSON.parse(body || "{}");
    const messages = request.messages ?? [];
    const tools = (request.tools ?? []).map((tool) => tool.function?.name);
    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({ id: "ux", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const call = (id, name, args) =>
      chunk({
        tool_calls: [
          { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
        ],
      }) + chunk({}, "tool_calls");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const lastUser = messages.map((message) => message.role).lastIndexOf("user");
    const toolResults = messages
      .slice(lastUser)
      .filter((message) => message.role === "tool").length;
    if (!request.stream || !tools.length)
      res.write(chunk({ content: "添加 clamp" }) + chunk({}, "stop"));
    else if (toolResults === 0)
      res.write(
        call("r1", tools.find((name) => /fs_read|read_file/.test(name)) ?? "fs_read", {
          path: "src/math.ts",
        }),
      );
    else if (toolResults === 1)
      res.write(
        call("c1", "run_command", {
          argv: ["npm", "view", "vitest", "version"],
          permissionRequest: { network: true, justification: "查询 vitest 版本用来补测试。" },
        }),
      );
    else res.write(chunk({ content: reply }) + chunk({}, "stop"));
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((ready) => model.listen(0, "127.0.0.1", ready));
const port = model.address().port;

const project = join(scratch, "demo");
await mkdir(join(project, "src"), { recursive: true });
await writeFile(join(project, "README.md"), "# demo\n");
await writeFile(
  join(project, "src/math.ts"),
  "export const add = (a: number, b: number) => a + b;\n",
);
execFileSync("git", ["init", "-q"], { cwd: project });
execFileSync("git", ["add", "."], { cwd: project });
execFileSync(
  "git",
  ["-c", "user.name=ux", "-c", "user.email=ux@example.invalid", "commit", "-qm", "init"],
  {
    cwd: project,
  },
);

async function launch(name, withModel) {
  const root = join(scratch, name);
  await mkdir(join(root, "home"), { recursive: true });
  const config = join(root, "config.toml");
  await writeFile(
    config,
    withModel
      ? `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${port}/v1/chat/completions"\n`
      : "schema_version=1\n",
  );
  const env = {
    ...process.env,
    HOME: join(root, "home"),
    AREAL_GUI: "workbench",
    AREAL_BACKEND: "areal",
    AREAL_CORE_BIN: process.env.AREAL_CORE_BIN ?? resolve(gui, "../../target/debug/areal"),
    AREAL_CORE_HOME: join(root, "core"),
    AREAL_CORE_USER_HOME: join(root, "home"),
    AREAL_HARNESS_HOME: join(root, "runtime"),
    AREAL_HARNESS_SERVICE_HOME: join(root, "registry"),
    AREAL_CORE_CONFIG: config,
    AREAL_GUI_USER_DATA: join(root, "electron"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AREAL_CORE_WORKSPACE;
  const app = await electron.launch({
    executablePath: require("electron"),
    // Chromium 拒绝以 root 带沙箱启动；只在云端容器这类 root 环境关掉。
    args: [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), join(gui, "app")],
    env,
    timeout: 120_000,
  });
  console.log(`… ${name} 已启动`);
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  await page.getByTestId("chat-input").first().waitFor({ timeout: 90_000 });
  // 后台退出可能等待保存或确认；限时关闭后强制结束这一个 Electron 进程。
  const close = async () => {
    await Promise.race([app.close(), new Promise((done) => setTimeout(done, 10_000))]);
    app.process().kill("SIGKILL");
  };
  return {
    app,
    page,
    close,
    shot: (step) => page.screenshot({ path: join(shots, `${name}-${step}.png`) }),
  };
}

// 杀掉 Electron 后，它拉起的后台进程可能还在；只按本次临时目录认领，不按名字匹配。
async function stopLeftovers() {
  if (process.platform !== "linux") return;
  // Host 只带 AREAL_HARNESS_SERVICE_HOME，Core 带 AREAL_CORE_HOME；任一指向本次临时目录就是自己的。
  const owned = (entry) => entry.startsWith("AREAL_") && entry.includes(`=${scratch}/`);
  // Host 与服务进程会互相拉起：先全部暂停再杀，直到一个不剩。
  for (let pass = 0; pass < 5; pass += 1) {
    const pids = [];
    for (const pid of await readdir("/proc").catch(() => [])) {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
      const environ = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
      if (environ.split("\0").some(owned)) pids.push(Number(pid));
    }
    if (!pids.length) return;
    for (const signal of ["SIGSTOP", "SIGKILL"])
      for (const pid of pids)
        try {
          process.kill(pid, signal);
        } catch {}
  }
}

try {
  // 旅程 1：没有模型时，输入框旁的按钮直达模型设置。
  {
    const { page, shot, close } = await launch("j1", false);
    const configure = page.getByRole("button", { name: "配置模型", exact: true });
    await configure.waitFor();
    record(await inspectPage(page, "旅程1 没模型的首页"));
    record(
      await expectFeedback(page, "旅程1 点配置模型", () => configure.click(), {
        until: page.locator('.settings-navigation-item[aria-current="page"]'),
      }),
    );
    await page.getByRole("button", { name: "模型设置", exact: true }).waitFor();
    assert.equal(
      await page.locator('.settings-navigation-item[aria-current="page"]').innerText(),
      "模型设置",
      "配置模型打开的是模型设置页",
    );
    await shot("settings");
    record(await inspectPage(page, "旅程1 模型设置页"));
    await close();
  }
  // 旅程 3、4：打开项目、发消息、审批时继续输入，再看右上角摘要。
  {
    const { app, page, shot, close } = await launch("j3", true);
    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, project);
    const categories = page.locator('button[aria-label="项目分类"]');
    if ((await categories.getAttribute("aria-expanded")) === "false") await categories.click();
    await page.locator('button[aria-label="打开项目"]').click();
    const choice = page.getByRole("menuitem").first();
    if (await choice.isVisible().catch(() => false)) await choice.click();
    await page
      .locator('button[aria-label="在项目 demo 中新建对话"]')
      .click({ force: true, timeout: 60_000 });
    const input = page.getByTestId("chat-input").first();
    await input.fill("给 src/math.ts 加一个 clamp 函数");
    record(
      await expectFeedback(page, "旅程3 回车发送", () => input.press("Enter"), {
        until: page.locator(".messages").getByText("给 src/math.ts 加一个 clamp 函数"),
      }),
    );
    const approval = page.locator('.decision-card[data-interaction="approval"]');
    await approval.waitFor({ timeout: 60_000 });
    await shot("approval");
    assert.equal(await input.isVisible(), true, "审批时输入框仍在");
    record(await inspectPage(page, "旅程3 等审批"));
    await input.fill("顺便把 README 也更新");
    record(
      await expectFeedback(page, "旅程3 审批中排队", () => input.press("Enter"), {
        until: page.locator(".composer-queue"),
      }),
    );
    await page.locator(".composer-queue").waitFor();
    await shot("queued");
    record(await inspectPage(page, "旅程3 审批卡与排队消息"));
    await approval
      .getByRole("button", { name: /允许/ })
      .first()
      .click();
    await page.getByText("已添加 clamp").first().waitFor({ timeout: 60_000 });
    record(await inspectPage(page, "旅程3 本轮完成"));

    const summary = page.locator('button[aria-label="任务资源"]');
    record(await expectFeedback(page, "旅程4 打开右上角摘要", () => summary.click()));
    const popup = page.locator(".task-resources-popup");
    await popup.waitFor();
    await shot("summary");
    record(await inspectPage(page, "旅程4 摘要卡"));
    await page.mouse.click(500, 450);
    await popup.waitFor({ state: "hidden" });
    await close();
  }
} finally {
  await stopLeftovers();
  model.closeAllConnections();
  model.close();
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
}
const failed = results.filter((result) => result.problems.length);
console.log(`${results.length - failed.length}/${results.length} 步通过；截图在 ${shots}`);
// 桌面退出后留下的后台子进程会占住事件循环，结果已出就直接退出。
process.exit(failed.length ? 1 : 0);
