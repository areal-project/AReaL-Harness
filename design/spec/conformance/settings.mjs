// 设置导航与设置页的行为验收。约定同 send-run-stop.mjs。
import fixture from "../fixtures/send-run-stop.json" with { type: "json" };

const title = fixture.navigation.projects
  .flatMap((project) => project.threads)
  .find((thread) => thread.id === "spec-thread").title;
const nav = (page) => page.getByRole("navigation", { name: "设置导航" });
const item = (page, name) => nav(page).getByRole("button", { name, exact: true });

export const checks = [
  {
    id: "settings-open-and-back",
    flow: "window.sidebar → window.settings → window.sidebar",
    async run({ open, expect }) {
      const page = await open("window.sidebar");
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: "常规" })).toBeVisible();
      await expect(item(page, "常规")).toHaveAttribute("aria-current", "page");
      await page.getByRole("button", { name: "返回应用" }).click();
      await expect(nav(page)).toBeHidden();
      await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
    },
  },
  {
    id: "settings-switch-page",
    flow: "window.settings → window.settings-appearance",
    async run({ open, expect }) {
      const page = await open("window.settings");
      await item(page, "外观").click();
      await expect(page.getByRole("heading", { level: 1, name: "外观" })).toBeVisible();
      await expect(item(page, "外观")).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("heading", { level: 2, name: "交互与动效" })).toBeVisible();
    },
  },
  {
    id: "settings-search-filter-and-clear",
    flow: "window.settings → window.settings-search → window.settings",
    async run({ open, expect }) {
      const page = await open("window.settings");
      const search = page.getByRole("searchbox", { name: "搜索设置" });
      await search.fill("字号");
      await expect(item(page, "常规")).toBeHidden();
      await expect(nav(page).getByRole("button", { name: /外观/ })).toContainText("字号");
      await search.fill("没有这一项");
      await expect(page.getByText("没有匹配的设置")).toBeVisible();
      await page.getByRole("button", { name: "清除设置搜索" }).click();
      await expect(item(page, "常规")).toBeVisible();
      await expect(item(page, "手机连接")).toBeVisible();
    },
  },
  {
    id: "settings-switch-toggles",
    flow: "window.settings-appearance → window.settings-appearance",
    async run({ open, expect }) {
      const page = await open("window.settings-appearance");
      const toggle = page.getByRole("switch", { name: "使用指针光标" });
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
    },
  },
  {
    id: "settings-select-option",
    flow: "window.settings-appearance → window.settings-select → window.settings-appearance",
    async run({ open, expect }) {
      const page = await open("window.settings-appearance");
      const theme = page.getByRole("combobox", { name: "界面主题" });
      await theme.click();
      await expect(page.getByRole("option", { name: "跟随系统" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await page.getByRole("option", { name: "深色" }).click();
      await expect(page.getByRole("option", { name: "深色" })).toBeHidden();
      await expect(theme).toContainText("深色");
    },
  },
];
