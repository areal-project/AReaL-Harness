// 网页业务旅程：真实 Host、后台和 Core，外部模型是本地假模型，界面在 Chromium 里打开 Host 的本机网页。
// 网页与桌面是同一份界面、同一套 Host 协议，所以这里通过的业务旅程不必再在 Mac 上逐项点一遍。
// 桌面窗口只用来做一次引导：网页需要桌面先登记资料库来源，引导后立即关闭。
// 先构建 Core（make build）和界面（pnpm --dir clients/gui build），再运行：
//   node clients/gui/scripts/web-journeys.mjs [--out <截图目录>]
// Linux 没有显示服务时用 xvfb-run 包一层；浏览器下载不到时设 AREAL_CHROMIUM 指向已装好的 Chromium。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  coreBin,
  createScene,
  playwright,
  reply,
  sendReady,
  startModel,
} from "./support/journey-fixture.mjs";
import { expectFeedback, inspectPage, recordToasts } from "./ux-checks.mjs";

const outIndex = process.argv.indexOf("--out");
const shots = resolve(
  outIndex > 0 ? process.argv[outIndex + 1] : join(tmpdir(), "areal-web-shots"),
);
await mkdir(shots, { recursive: true });
const results = [];
const record = (result) => {
  results.push(result);
  if (result.problems.length) console.log(`✗ ${result.step}: ${result.problems.join("；")}`);
  else console.log(`✓ ${result.step}`);
};
const model = await startModel();
const scene = await createScene("areal-web-");
let browser;
let page;
const shot = (step) => page.screenshot({ path: join(shots, `web-${step}.png`) });

try {
  // 引导：桌面第一次启动时登记资料库来源并让 Host 记住后台启动参数，然后关闭。
  const desktop = await scene.launchDesktop("web", model.port);
  const env = desktop.env;
  const { port } = JSON.parse(
    await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/web-bind.json"), "utf8"),
  );
  await desktop.close();
  console.log(`… Host 网页在 127.0.0.1:${port}，桌面窗口已关闭`);

  browser = await playwright.chromium.launch({
    executablePath: process.env.AREAL_CHROMIUM || undefined,
    args: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });
  await context.addInitScript(recordToasts);
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // 旅程 W0：浏览器第一次打开要本机批准；批准后进入工作台。
  await page.goto(`http://127.0.0.1:${port}/`);
  const pending = page.getByText(/areal host web approve [0-9a-f-]{36}/);
  await pending.waitFor({ timeout: 60_000 });
  // 批准页按设计要显示带设备标识的命令，不做“无原始标识”检查。
  await shot("pairing");
  const device = (await pending.innerText()).match(/approve ([0-9a-f-]{36})/)[1];
  execFileSync(
    coreBin,
    ["host", "web", "approve", device, "--scope", "observe,submit,approve,manage"],
    { env, stdio: "ignore" },
  );
  await page.getByText("检查批准状态").click();
  await page.getByTestId("chat-input").first().waitFor({ timeout: 60_000 });
  record(await inspectPage(page, "W0 批准后进入工作台"));

  // 旅程 W1：网页里按路径打开项目，新建对话。
  page.once("dialog", (dialog) => dialog.accept(scene.project));
  const categories = page.locator('button[aria-label="项目分类"]');
  if ((await categories.getAttribute("aria-expanded")) === "false") await categories.click();
  await page.locator('button[aria-label="打开项目"]').click();
  const choice = page.getByRole("menuitem").first();
  if (await choice.isVisible().catch(() => false)) await choice.click();
  const create = page.locator('button[aria-label="在项目 demo 中新建对话"]');
  await create.waitFor({ timeout: 60_000 });
  await shot("project");
  record(await inspectPage(page, "W1 网页打开项目"));
  await create.click({ force: true });

  // 旅程 W2：发送 → 审批卡出现、输入框仍在 → 审批中继续排队 → 允许 → 本轮完成。
  const input = page.getByTestId("chat-input").first();
  await input.fill("给 src/math.ts 加一个 clamp 函数");
  await sendReady(page);
  record(
    await expectFeedback(page, "W2 回车发送", () => input.press("Enter"), {
      until: page.locator(".messages").getByText("给 src/math.ts 加一个 clamp 函数"),
    }),
  );
  const approval = page.locator('.decision-card[data-interaction="approval"]');
  await approval.waitFor({ timeout: 60_000 });
  await shot("approval");
  assert.equal(await input.isVisible(), true, "审批时输入框仍在");
  record(await inspectPage(page, "W2 等审批"));
  await input.fill("顺便把 README 也更新");
  record(
    await expectFeedback(page, "W2 审批中排队", () => input.press("Enter"), {
      until: page.locator(".composer-queue"),
    }),
  );
  await approval
    .getByRole("button", { name: /允许/ })
    .first()
    .click();
  await page
    .getByText(reply.split("\n")[0].replace("## ", ""))
    .first()
    .waitFor({ timeout: 60_000 });
  await shot("done");
  record(await inspectPage(page, "W2 本轮完成"));

  // 旅程 W3：刷新后对话还在（Host 是唯一真相，不靠页面内存）。
  await page.reload();
  await page.getByText("已添加 clamp").first().waitFor({ timeout: 60_000 });
  record(await inspectPage(page, "W3 刷新后对话仍在"));

  // 旅程 W4：设置页能打开模型设置。
  await page.locator('button[aria-label*="设置"]').first().click();
  await page.locator(".settings-navigation-item").first().waitFor();
  await shot("settings");
  record(await inspectPage(page, "W4 设置页"));

  assert.deepEqual(pageErrors, [], "页面没有未捕获异常");
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(shots, "web-failure.png") }).catch(() => {});
    const text = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    console.log(`失败时页面正文：\n${text.slice(0, 2000)}`);
  }
  throw error;
} finally {
  await browser?.close();
  await scene.dispose();
  model.close();
}
const failed = results.filter((result) => result.problems.length);
console.log(`${results.length - failed.length}/${results.length} 步通过；截图在 ${shots}`);
process.exit(failed.length ? 1 : 0);
