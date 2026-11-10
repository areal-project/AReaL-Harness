// 旅程脚本共用的现场：本地假模型、示例 Git 项目、隔离目录里的 Electron 与 Host、按临时目录认领的清理。
// 只有外部模型是假的；Host、后台、Core 都是真实构建产物，状态全在临时目录里，不碰本机真实数据。
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./temp.mjs";
import { recordToasts } from "../ux-checks.mjs";

export const gui = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const require = createRequire(join(gui, "app/package.json"));
export const playwright = require("playwright-core");
export const coreBin = process.env.AREAL_CORE_BIN ?? resolve(gui, "../../target/debug/areal");
export const reply = "## 已添加 clamp\n\n在 `src/math.ts` 加了 `clamp`，并补了边界测试。";

/** 假模型：读文件 → 要联网的命令（触发审批）→ 最终回答。每条新用户消息重新走一遍。 */
export async function startModel() {
  const model = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
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
  return {
    port: model.address().port,
    close() {
      model.closeAllConnections();
      model.close();
    },
  };
}

/** 一个隔离现场：临时目录、示例项目、启动 Electron 所需的环境变量。 */
export async function createScene(prefix) {
  const scratch = await makeTempDir(prefix);
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
    { cwd: project },
  );

  async function environment(name, modelPort) {
    const root = join(scratch, name);
    await mkdir(join(root, "home"), { recursive: true });
    const config = join(root, "config.toml");
    await writeFile(
      config,
      modelPort
        ? `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${modelPort}/v1/chat/completions"\n`
        : "schema_version=1\n",
    );
    const env = {
      ...process.env,
      HOME: join(root, "home"),
      AREAL_GUI: "workbench",
      AREAL_BACKEND: "areal",
      AREAL_CORE_BIN: coreBin,
      AREAL_CORE_HOME: join(root, "core"),
      AREAL_CORE_USER_HOME: join(root, "home"),
      AREAL_HARNESS_HOME: join(root, "runtime"),
      AREAL_HARNESS_SERVICE_HOME: join(root, "registry"),
      AREAL_CORE_CONFIG: config,
      AREAL_GUI_USER_DATA: join(root, "electron"),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.AREAL_CORE_WORKSPACE;
    return env;
  }

  /** 启动桌面窗口，等输入框出现；返回 Electron 应用、窗口与关闭方法。 */
  async function launchDesktop(name, modelPort) {
    const env = await environment(name, modelPort);
    const app = await playwright._electron.launch({
      executablePath: require("electron"),
      // Chromium 拒绝以 root 带沙箱启动；只在云端容器这类 root 环境关掉。
      args: [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), join(gui, "app")],
      env,
      timeout: 120_000,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(20_000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.getByTestId("chat-input").first().waitFor({ timeout: 90_000 });
    // 重载一次让提示记录先于界面装上，启动时冒出的提示也算在内。
    await app.context().addInitScript(recordToasts);
    await page.reload();
    await page.getByTestId("chat-input").first().waitFor({ timeout: 90_000 });
    // 后台退出可能等待保存或确认；限时关闭后强制结束这一个 Electron 进程。
    const close = async () => {
      await Promise.race([app.close(), new Promise((done) => setTimeout(done, 10_000))]);
      app.process().kill("SIGKILL");
    };
    return { app, page, env, close };
  }

  // 杀掉 Electron 后，它拉起的后台进程可能还在；只按本次临时目录认领，不按名字匹配。
  async function stopLeftovers() {
    if (process.platform !== "linux") return;
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

  async function dispose() {
    await stopLeftovers();
    await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  }

  return { scratch, project, environment, launchDesktop, dispose };
}

/** 在桌面窗口里把示例项目加进侧边栏（替换系统文件选择框），再新建一个对话。 */
export async function openProjectInDesktop(app, page, project) {
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
}

/** 项目连上、模型目录就绪前发送不可用，此时回车只会换行；等发送可用再交给调用方。 */
export function sendReady(page) {
  return page
    .locator('button[aria-label="发送"]:not([disabled])')
    .first()
    .waitFor({ timeout: 60_000 });
}
