// 插件中心的行为验收。约定同 send-run-stop.mjs。
const rail = (page, name) =>
  page.getByRole("navigation", { name: "应用导航" }).getByRole("button", { name, exact: true });
const nav = (page) => page.getByRole("complementary", { name: "插件导航" });
const navItem = (page, name) => nav(page).getByRole("button", { name, exact: true });
const plugin = (page, id) => page.getByRole("article", { name: new RegExp(`插件 ${id}$`) });
const IDS = ["github@official", "linear@official", "review-kit@official", "figma@official"];

export const checks = [
  {
    id: "plugins-open-from-rail",
    flow: "window.sidebar → window.plugins → window.sidebar",
    async run({ open, expect }) {
      const page = await open("window.sidebar");
      await rail(page, "插件").click();
      await expect(rail(page, "插件")).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("heading", { name: "插件市场", level: 1 })).toBeVisible();
      await expect(navItem(page, "插件市场")).toHaveAttribute("aria-current", "page");
      for (const id of IDS) await expect(plugin(page, id)).toBeVisible();
      await rail(page, "首页").click();
      await expect(nav(page)).toBeHidden();
    },
  },
  {
    id: "plugins-installed-and-actions",
    flow: "window.plugins",
    async run({ open, expect }) {
      const page = await open("window.plugins");
      for (const name of ["GitHub", "代码审查工具包"])
        await expect(navItem(page, name)).toBeVisible();
      await expect(navItem(page, "Linear")).toBeHidden();
      await expect(page.getByRole("button", { name: "管理插件 github@official" })).toContainText(
        "已添加",
      );
      await expect(page.getByRole("button", { name: "添加插件 linear@official" })).toBeVisible();
      await expect(page.getByRole("button", { name: "管理插件 linear@official" })).toBeHidden();
    },
  },
  {
    id: "plugins-search-filters",
    flow: "window.plugins → window.plugins",
    async run({ open, expect }) {
      const page = await open("window.plugins");
      const search = page.getByRole("searchbox", { name: "搜索插件包" });
      await search.fill("设计稿");
      await expect(plugin(page, "figma@official")).toBeVisible();
      await expect(page.getByRole("article")).toHaveCount(1);
      await search.fill("");
      await expect(page.getByRole("article")).toHaveCount(4);
    },
  },
  {
    id: "plugins-scope-tabs",
    flow: "window.plugins → window.plugins",
    async run({ open, expect }) {
      const page = await open("window.plugins");
      const scope = page.getByRole("tablist", { name: "市场范围" });
      const publicTab = scope.getByRole("tab", { name: "公共" });
      await expect(publicTab).toHaveAttribute("aria-selected", "true");
      await publicTab.focus();
      await page.keyboard.press("ArrowRight");
      await expect(scope.getByRole("tab", { name: "个人" })).toBeFocused();
      await scope.getByRole("tab", { name: "个人" }).click();
      await expect(scope.getByRole("tab", { name: "个人" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.getByRole("button", { name: "添加插件市场" })).toBeVisible();
      await expect(page.getByRole("article")).toHaveCount(0);
      await publicTab.click();
      await expect(page.getByRole("article")).toHaveCount(4);
    },
  },
  {
    id: "plugins-detail-and-back",
    flow: "window.plugins → window.plugins",
    async run({ open, expect }) {
      const page = await open("window.plugins");
      await page.getByRole("button", { name: "查看插件 linear@official" }).click();
      const crumbs = page.getByRole("navigation", { name: "面包屑" });
      await expect(crumbs).toContainText("Linear");
      await expect(page.getByRole("heading", { name: "Linear", level: 1 })).toBeVisible();
      await crumbs.getByRole("button", { name: "返回插件列表" }).click();
      await expect(page.getByRole("heading", { name: "插件市场", level: 1 })).toBeVisible();
      await expect(plugin(page, "linear@official")).toBeVisible();
    },
  },
  {
    id: "plugins-navigation-pages",
    flow: "window.plugins → window.plugins",
    async run({ open, expect }) {
      const page = await open("window.plugins");
      await navItem(page, "Skills").click();
      await expect(navItem(page, "Skills")).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
      await navItem(page, "GitHub").click();
      await expect(navItem(page, "GitHub")).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("heading", { name: "GitHub", level: 1 })).toBeVisible();
      await navItem(page, "插件市场").click();
      await expect(page.getByRole("heading", { name: "插件市场", level: 1 })).toBeVisible();
    },
  },
];
