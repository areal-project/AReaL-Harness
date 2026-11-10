// 右侧面板的行为验收。约定同 send-run-stop.mjs。
const toggle = (page) => page.getByRole("button", { name: "展开侧边面板" });
const tabs = (page) => page.getByRole("tablist", { name: "侧边面板标签" });
const tab = (page, name) => tabs(page).getByRole("tab", { name, exact: true });
const entry = (page, name) => page.getByRole("button", { name: new RegExp(`^${name}`) });

export const checks = [
  {
    id: "panel-open-launcher-and-close",
    flow: "window.sidebar → window.panel → window.sidebar",
    async run({ open, expect }) {
      const page = await open("window.sidebar");
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
      await toggle(page).click();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      for (const name of ["审查", "终端", "浏览器", "文件"])
        await expect(entry(page, name)).toBeVisible();
      await page.getByRole("button", { name: "关闭面板" }).click();
      await expect(entry(page, "审查")).toBeHidden();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    },
  },
  {
    id: "panel-launcher-opens-tab",
    flow: "window.panel → window.panel-tabs",
    async run({ open, expect }) {
      const page = await open("window.panel");
      await entry(page, "审查").click();
      await expect(tab(page, "审查")).toHaveAttribute("aria-selected", "true");
      await expect(entry(page, "终端")).toBeHidden();
    },
  },
  {
    id: "panel-reopens-last-tab",
    flow: "window.panel-tabs → window.sidebar → window.panel-tabs",
    async run({ open, expect }) {
      const page = await open("window.panel-tabs");
      await tab(page, "审查").click();
      await page.getByRole("button", { name: "关闭面板" }).click();
      await expect(tabs(page)).toBeHidden();
      await toggle(page).click();
      await expect(tab(page, "审查")).toHaveAttribute("aria-selected", "true");
      await expect(tab(page, "文件")).toBeVisible();
    },
  },
  {
    id: "panel-delete-closes-tabs",
    flow: "window.panel-tabs → window.panel-tabs → window.sidebar",
    async run({ open, expect }) {
      const page = await open("window.panel-tabs");
      await tab(page, "文件").focus();
      await page.keyboard.press("Delete");
      await expect(tab(page, "文件")).toBeHidden();
      await expect(tab(page, "审查")).toHaveAttribute("aria-selected", "true");
      await expect(tab(page, "审查")).toBeFocused();
      await page.keyboard.press("Delete");
      await expect(tabs(page)).toBeHidden();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    },
  },
  {
    id: "panel-add-menu",
    flow: "window.panel-tabs → window.panel-add-menu → window.panel-tabs",
    async run({ open, expect }) {
      const page = await open("window.panel-tabs");
      await page.getByRole("button", { name: "打开侧边面板标签页" }).click();
      const menu = page.getByRole("menu");
      await expect(menu.getByRole("menuitem", { name: /^终端/ })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /^浏览器/ })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "搜索标签页" })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /^审查/ })).toHaveCount(0);
      await expect(menu.getByRole("menuitem", { name: /^文件/ })).toHaveCount(0);
      await menu.getByRole("menuitem", { name: /^终端/ }).click();
      await expect(menu).toBeHidden();
      await expect(tab(page, "终端")).toHaveAttribute("aria-selected", "true");
    },
  },
  {
    id: "panel-full-view",
    flow: "window.panel-tabs → window.panel-full → window.panel-tabs",
    async run({ open, expect }) {
      const page = await open("window.panel-tabs");
      await page.getByRole("button", { name: "进入完整视图" }).click();
      await expect(page.getByRole("button", { name: "退出完整视图" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(toggle(page)).toBeHidden();
      await expect(tabs(page).getByRole("tab")).toHaveCount(3);
      await page.getByRole("button", { name: "进入分屏视图" }).click();
      await expect(toggle(page)).toBeVisible();
      await expect(page.getByRole("button", { name: "进入完整视图" })).toBeVisible();
    },
  },
  {
    id: "panel-resize-keyboard",
    flow: "window.panel-tabs → window.panel-tabs",
    async run({ open, expect }) {
      const page = await open("window.panel-tabs");
      const handle = page.getByRole("separator", { name: "调整侧边面板宽度" });
      await expect(handle).toHaveAttribute("aria-valuenow", "45");
      await handle.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(handle).toHaveAttribute("aria-valuenow", "47");
    },
  },
];
