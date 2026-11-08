// 菜单、弹窗与提示的行为验收。约定同 send-run-stop.mjs。
import fixture from "../fixtures/send-run-stop.json" with { type: "json" };

const title = fixture.navigation.projects
  .flatMap((project) => project.threads)
  .find((thread) => thread.id === "spec-thread").title;
const taskMenu = (page) => page.getByRole("button", { name: `任务操作 ${title}` });

export const checks = [
  {
    id: "task-menu-items-and-escape",
    flow: "window.sidebar → window.task-menu → window.sidebar",
    async run({ open, expect }) {
      const page = await open("window.sidebar");
      await page.getByText(title, { exact: true }).first().hover();
      await taskMenu(page).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      const items = await menu.getByRole("menuitem").allTextContents();
      const expected = ["重命名", "置顶", "标为未读", "上移", "下移", "归档"];
      if (items.map((item) => item.trim()).join() !== expected.join())
        throw new Error(`menu items ${items.join("/")}`);
      await expect(menu.getByRole("menuitem", { name: "上移" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(taskMenu(page)).toBeFocused();
    },
  },
  {
    id: "organize-submenu-radio",
    flow: "window.sidebar → window.organize-menu → window.sidebar",
    async run({ open, expect }) {
      const page = await open("window.sidebar");
      await page.getByRole("button", { name: "侧栏整理" }).click();
      const trigger = page.getByRole("menuitem", { name: "项目内任务排序" });
      await trigger.focus();
      await page.keyboard.press("ArrowRight");
      const current = page.getByRole("menuitemradio", { name: "最近更新" });
      await expect(current).toBeVisible();
      await expect(current).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("ArrowLeft");
      await expect(current).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toBeHidden();
    },
  },
  {
    id: "rename-saves-new-title",
    flow: "window.task-menu → window.rename → window.sidebar",
    async run({ open, expect }) {
      const page = await open("window.task-menu");
      await page.getByRole("menuitem", { name: "重命名" }).click();
      const dialog = page.getByRole("dialog", { name: "重命名" });
      await expect(dialog).toBeVisible();
      const name = dialog.getByRole("textbox", { name: "名称" });
      await expect(name).toHaveText(title);
      await name.fill("   ");
      await expect(dialog.getByRole("button", { name: "保存" })).toBeDisabled();
      await name.fill("给 clamp 补测试");
      await page.keyboard.press("Enter");
      await expect(dialog).toBeHidden();
      await expect(page.locator('[aria-current="page"]', { hasText: "给 clamp 补测试" })).toBeVisible();
      // 侧栏这一行与会话标题栏各一处。
      await expect(page.getByText("给 clamp 补测试", { exact: true }).nth(1)).toBeVisible();
    },
  },
  {
    id: "rename-cancel-keeps-title",
    flow: "window.rename → window.sidebar",
    async run({ open, expect }) {
      const page = await open("window.rename");
      const dialog = page.getByRole("dialog", { name: "重命名" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("textbox", { name: "名称" }).fill("不该保存");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page.locator('[aria-current="page"]', { hasText: title })).toBeVisible();
      await page.getByText(title, { exact: true }).first().hover();
      await taskMenu(page).click();
      await page.getByRole("menuitem", { name: "重命名" }).click();
      await dialog.getByRole("button", { name: "取消" }).click();
      await expect(dialog).toBeHidden();
    },
  },
  {
    id: "send-tooltip-on-hover",
    flow: "home.draft → home.tooltip → home.draft",
    async run({ open, expect }) {
      const page = await open("home.draft");
      const send = page.getByRole("button", { name: "发送" });
      await send.hover();
      const tooltip = page.getByRole("tooltip");
      await expect(tooltip).toContainText("发送");
      await expect(tooltip).toContainText("Enter");
      await page.mouse.move(0, 0);
      await expect(tooltip).toBeHidden();
    },
  },
];
