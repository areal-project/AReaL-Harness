import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withSmokeDeadline } from "./smoke-deadline.mjs";

export async function createProjectConversation(page, projectName) {
  await page
    .locator(".project-row")
    .filter({ has: page.getByRole("button", { name: projectName, exact: true }) })
    .hover();
  const create = page.getByRole("button", {
    name: `在项目 ${projectName} 中新建对话`,
    exact: true,
  });
  // 用键盘激活同一按钮，避免恢复布局或真实鼠标移动收起悬浮操作区。
  await create.focus();
  await create.press("Enter");
  await page.getByTestId("chat-input").waitFor();
}

export async function selectConversation(page, threadId) {
  await page.getByTestId(`task-item-${threadId}`).click();
  await page.waitForFunction(
    (id) => document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId === id,
    threadId,
  );
  await page.getByTestId("chat-input").waitFor();
}

export async function openSideChat(page) {
  const addTab = page.getByRole("button", { name: "打开侧边面板标签页", exact: true });
  if (await addTab.isVisible()) {
    await addTab.click();
    await page.getByRole("menuitem", { name: /侧边聊天/ }).click();
  } else {
    const launcher = page.locator('[data-side-pane-open-tab-item="side"]');
    if (!(await launcher.isVisible()))
      await page.getByRole("button", { name: "展开侧边面板", exact: true }).click();
    await launcher.click();
  }
  await page.getByTestId("side-chat-pane").filter({ visible: true }).waitFor();
}

export async function resizeConversation(app, page, width, height) {
  // 窄窗的对话区由现有侧栏状态控制，先完成用户可见的收起操作。
  const collapse = page.getByRole("button", { name: "收起侧栏", exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(Math.min(640, size.width), 480);
      window.setSize(size.width, size.height);
    },
    { width, height },
  );
  await page.waitForFunction((target) => innerWidth <= target, width);
  await page.getByTestId("chat-input").waitFor();
}

export async function captureSmokeFailure(page, scratch, error) {
  const state = { error: error.stack ?? String(error) };
  const files = [];
  try {
    Object.assign(
      state,
      await withSmokeDeadline("failure state capture", () =>
        page.evaluate(() => {
          const workbench = document.querySelector('[data-testid="areal-workbench"]');
          return {
            url: location.href,
            viewport: { width: innerWidth, height: innerHeight },
            projectId: workbench?.dataset.projectId,
            threadId: workbench?.dataset.threadId,
            sidebarCollapsed: document.querySelector(".sidebar")?.dataset.collapsed,
            body: document.body.innerText.slice(0, 16384),
          };
        }),
      ),
    );
  } catch (failure) {
    state.stateCaptureError = failure.message;
  }
  try {
    // 保留整窗而非 Composer 裁剪；导航失败时侧栏和空白区也是证据。
    await withSmokeDeadline("failure screenshot capture", () =>
      page.screenshot({
        path: join(scratch, "failure-window.png"),
        scale: "css",
        animations: "disabled",
        timeout: 10000,
      }),
    );
    files.push("failure-window.png");
  } catch (failure) {
    state.screenshotError = failure.message;
  }
  try {
    await writeFile(join(scratch, "failure-state.json"), JSON.stringify(state, null, 2));
    files.push("failure-state.json");
  } catch (failure) {
    console.error("Smoke failure evidence:", failure.message);
  }
  return files;
}
