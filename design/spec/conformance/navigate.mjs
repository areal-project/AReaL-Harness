// 侧栏与搜索的行为验收。约定同 send-run-stop.mjs。
import fixture from "../fixtures/send-run-stop.json" with { type: "json" };

const nav = fixture.navigation;
const threads = nav.projects.flatMap((project) => project.threads);
const title = (id) => [...threads, ...nav.chats].find((thread) => thread.id === id).title;
const current = (page, text) => page.locator('[aria-current="page"]', { hasText: text });

export const checks = [
  {
    id: "sidebar-groups-and-status",
    flow: "window.sidebar",
    async run({ open, expect }) {
      const page = await open("window.sidebar");
      for (const name of ["置顶分类", "项目分类", "独立任务分类"])
        await expect(page.getByRole("button", { name })).toBeVisible();
      await expect(current(page, title("spec-thread"))).toBeVisible();
      for (const name of ["运行中", "等待处理", "未读"])
        await expect(page.getByRole("img", { name })).toBeVisible();
    },
  },
  {
    id: "project-collapse-and-expand",
    flow: "window.sidebar → window.collapsed → window.sidebar",
    async run({ open, expect }) {
      const page = await open("window.sidebar");
      const project = page.getByRole("button", { name: "文档站", exact: true });
      await project.click();
      await expect(page.getByText(title("t-nav"))).toBeHidden();
      await expect(project).toHaveAttribute("aria-expanded", "false");
      await project.click();
      await expect(page.getByText(title("t-nav"))).toBeVisible();
    },
  },
  {
    id: "section-collapse-and-expand",
    flow: "window.sidebar → window.sidebar",
    async run({ open, expect }) {
      const page = await open("window.sidebar");
      const section = page.getByRole("button", { name: "项目分类" });
      await section.click();
      await expect(page.getByText(title("t-lint"))).toBeHidden();
      await expect(section).toHaveAttribute("aria-expanded", "false");
      await section.click();
      await expect(page.getByText(title("t-lint"))).toBeVisible();
    },
  },
  {
    id: "search-filter-and-close",
    flow: "window.sidebar → window.search → window.search-query → window.sidebar",
    async run({ open, expect }) {
      const page = await open("window.sidebar");
      await page.getByRole("button", { name: "搜索任务" }).click();
      const dialog = page.getByRole("dialog", { name: "搜索任务" });
      await expect(dialog).toBeVisible();
      await page.getByRole("textbox", { name: "搜索任务" }).fill("readme");
      await expect(dialog.getByText(title("t-readme"))).toBeVisible();
      await expect(dialog.getByText(title("t-lint"))).toBeHidden();
      await page.getByRole("button", { name: "关闭搜索" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText(title("t-lint"))).toBeVisible();
    },
  },
  {
    id: "search-result-opens-thread",
    flow: "window.search → window.sidebar",
    async run({ open, expect }) {
      const page = await open("window.search");
      const dialog = page.getByRole("dialog", { name: "搜索任务" });
      await dialog.getByText(nav.chats[0].title).click();
      await expect(dialog).toBeHidden();
      await expect(current(page, nav.chats[0].title)).toBeVisible();
    },
  },
  {
    id: "row-opens-thread",
    flow: "window.sidebar → window.sidebar",
    async run({ open, expect }) {
      const page = await open("window.sidebar");
      await page.getByText(title("t-release")).click();
      await expect(current(page, title("t-release"))).toBeVisible();
      await expect(current(page, title("spec-thread"))).toBeHidden();
    },
  },
  {
    id: "sidebar-collapse-and-expand",
    flow: "window.sidebar → window.rail → window.sidebar",
    async run({ open, expect }) {
      const page = await open("window.sidebar");
      await page.getByRole("button", { name: "收起侧栏" }).click();
      await expect(page.getByRole("button", { name: "新聊天" })).toBeHidden();
      await expect(page.getByRole("navigation", { name: "应用导航" })).toBeVisible();
      await page.getByRole("button", { name: "展开侧栏" }).click();
      await expect(page.getByRole("button", { name: "新聊天" })).toBeVisible();
    },
  },
];
