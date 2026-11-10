// 高频操作基线：在真实 Electron、后台和 Core 上走三条旅程，每步截图并跑 ux-checks 的 5 项检查。
// 旅程 1 没配模型去配置；旅程 3 打开项目、发消息、审批时继续排队；旅程 4 右上角摘要。
// 只有外部模型是本地假模型，状态全在临时目录里，不碰本机真实数据。
// 先构建 Core（cargo build -p areal-cli）和界面（pnpm --dir clients/gui build），再运行：
//   node clients/gui/scripts/ux-journeys.mjs [--out <截图目录>]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createScene,
  openProjectInDesktop,
  sendReady,
  startModel,
} from "./support/journey-fixture.mjs";
import { expectFeedback, inspectPage } from "./ux-checks.mjs";

const outIndex = process.argv.indexOf("--out");
const shots = resolve(outIndex > 0 ? process.argv[outIndex + 1] : join(tmpdir(), "areal-ux-shots"));
await mkdir(shots, { recursive: true });
const results = [];
let current; // 失败时给最后打开的窗口留截图和正文，方便判断卡在哪
const record = (result) => {
  results.push(result);
  if (result.problems.length) console.log(`✗ ${result.step}: ${result.problems.join("；")}`);
  else console.log(`✓ ${result.step}`);
};
const model = await startModel();
const scene = await createScene("areal-ux-");

async function launch(name, withModel) {
  const launched = await scene.launchDesktop(name, withModel ? model.port : undefined);
  console.log(`… ${name} 已启动`);
  current = { page: launched.page, name };
  return {
    ...launched,
    shot: (step) => launched.page.screenshot({ path: join(shots, `${name}-${step}.png`) }),
  };
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
    await openProjectInDesktop(app, page, scene.project);
    const input = page.getByTestId("chat-input").first();
    await input.fill("给 src/math.ts 加一个 clamp 函数");
    await sendReady(page);
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
} catch (error) {
  if (current) {
    await current.page
      .screenshot({ path: join(shots, `${current.name}-failure.png`) })
      .catch(() => {});
    const text = await current.page
      .locator("body")
      .innerText()
      .catch(() => "");
    console.log(`失败时页面正文（${current.name}）：\n${text.slice(0, 2000)}`);
  }
  throw error;
} finally {
  await scene.dispose();
  model.close();
}
const failed = results.filter((result) => result.problems.length);
console.log(`${results.length - failed.length}/${results.length} 步通过；截图在 ${shots}`);
// 桌面退出后留下的后台子进程会占住事件循环，结果已出就直接退出。
process.exit(failed.length ? 1 : 0);
