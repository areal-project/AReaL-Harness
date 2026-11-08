// 定时任务的行为验收。约定同 send-run-stop.mjs。
const rail = (page, name) =>
  page.getByRole("navigation", { name: "应用导航" }).getByRole("button", { name, exact: true });
const center = (page) => page.getByRole("region", { name: "定时任务中心" });
const item = (page, title) => page.getByRole("button", { name: `打开定时任务 ${title}` });
const dialog = (page) => page.getByRole("dialog", { name: "新建定时任务" });
const DAILY = "每天早上汇总昨天的提交和未关闭的问题";
const WEEKLY = "每周五整理本周发布说明";

export const checks = [
  {
    id: "tasks-open-from-rail",
    flow: "window.sidebar → window.tasks → window.sidebar",
    async run({ open, expect }) {
      const page = await open("window.sidebar");
      await rail(page, "定时任务").click();
      await expect(rail(page, "定时任务")).toHaveAttribute("aria-current", "page");
      await expect(center(page).getByRole("heading", { name: "定时任务", level: 1 })).toBeVisible();
      await expect(page.getByRole("group", { name: "已开启" })).toContainText(DAILY);
      await expect(page.getByRole("group", { name: "已暂停" })).toContainText(WEEKLY);
      await expect(page.getByRole("heading", { name: "安排任务" })).toBeVisible();
      await rail(page, "首页").click();
      await expect(center(page)).toBeHidden();
    },
  },
  {
    id: "tasks-search-filters-and-escape-clears",
    flow: "window.tasks → window.tasks",
    async run({ open, expect }) {
      const page = await open("window.tasks");
      await page.getByRole("button", { name: "搜索定时任务" }).click();
      const box = page.getByRole("textbox", { name: "搜索定时任务" });
      await expect(box).toBeFocused();
      await box.fill("发布");
      await expect(item(page, DAILY)).toBeHidden();
      await expect(page.getByRole("group", { name: "已开启" })).toBeHidden();
      await expect(item(page, WEEKLY)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(box).toBeHidden();
      await expect(item(page, DAILY)).toBeVisible();
    },
  },
  {
    id: "tasks-select-and-close-detail",
    flow: "window.tasks → window.tasks",
    async run({ open, expect }) {
      const page = await open("window.tasks");
      await item(page, WEEKLY).click();
      await expect(item(page, WEEKLY)).toHaveAttribute("aria-pressed", "true");
      await expect(item(page, DAILY)).toHaveAttribute("aria-pressed", "false");
      const detail = page.getByRole("main", { name: "定时任务会话" });
      await expect(detail.getByRole("heading", { name: WEEKLY })).toBeVisible();
      await page.getByRole("button", { name: "返回任务列表" }).click();
      await expect(page.getByRole("heading", { name: "安排任务" })).toBeVisible();
    },
  },
  {
    id: "tasks-toggle-list",
    flow: "window.tasks → window.tasks",
    async run({ open, expect }) {
      const page = await open("window.tasks");
      const toggle = page.getByRole("button", { name: "切换任务侧栏" });
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByRole("button", { name: "前进" })).toBeDisabled();
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("heading", { name: "定时任务", level: 1 })).toBeHidden();
      await toggle.click();
      await expect(item(page, DAILY)).toBeVisible();
    },
  },
  {
    id: "tasks-new-dialog",
    flow: "window.tasks → window.tasks-new → window.tasks",
    async run({ open, expect }) {
      const page = await open("window.tasks");
      await page.getByRole("button", { name: "新建定时任务" }).click();
      const instruction = dialog(page).getByRole("textbox", { name: "指令" });
      await expect(instruction).toBeFocused();
      await expect(dialog(page).getByRole("combobox", { name: "重复" })).toContainText("每天");
      await expect(dialog(page).getByRole("textbox", { name: "时间" })).toBeVisible();
      await expect(dialog(page).getByRole("button", { name: "创建" })).toBeDisabled();
      await instruction.fill("   ");
      await expect(dialog(page).getByRole("button", { name: "创建" })).toBeDisabled();
      await instruction.fill("每天检查依赖更新");
      await expect(dialog(page).getByRole("button", { name: "创建" })).toBeEnabled();
      await dialog(page).getByRole("button", { name: "取消" }).click();
      await expect(dialog(page)).toBeHidden();
      await expect(page.getByRole("group", { name: "已开启" })).toContainText(DAILY);
    },
  },
  {
    id: "tasks-new-weekly-and-advanced",
    flow: "window.tasks-new → window.tasks-new → window.tasks",
    async run({ open, expect }) {
      const page = await open("window.tasks-new");
      await dialog(page).getByRole("combobox", { name: "重复" }).click();
      await page.getByRole("option", { name: "每周" }).click();
      const days = dialog(page).getByRole("group", { name: "星期" });
      await expect(days.getByRole("button")).toHaveCount(7);
      const friday = days.getByRole("button", { name: "周五" });
      await expect(friday).toHaveAttribute("aria-pressed", "false");
      await friday.click();
      await expect(friday).toHaveAttribute("aria-pressed", "true");
      const advanced = dialog(page).getByRole("button", { name: "高级" });
      await expect(dialog(page).getByRole("switch", { name: "每次运行新开对话" })).toBeHidden();
      await advanced.click();
      await expect(advanced).toHaveAttribute("aria-expanded", "true");
      await expect(dialog(page).getByRole("combobox", { name: "模型" })).toContainText(
        "跟随当前默认",
      );
      await expect(dialog(page).getByRole("switch", { name: "每次运行新开对话" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toBeHidden();
    },
  },
  {
    id: "tasks-template-prefills",
    flow: "window.tasks → window.tasks-new",
    async run({ open, expect }) {
      const page = await open("window.tasks");
      await page.getByRole("button", { name: /^检查仓库进展/ }).click();
      await expect(dialog(page).getByRole("textbox", { name: "指令" })).toHaveText(
        "检查我指定仓库的公开提交与 PR，整理进展和待处理事项。",
      );
      await expect(dialog(page).getByRole("button", { name: "创建" })).toBeEnabled();
      await dialog(page).getByRole("button", { name: "关闭弹窗" }).click();
      await expect(dialog(page)).toBeHidden();
    },
  },
];
