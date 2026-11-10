// 审查面板的行为验收。约定同 send-run-stop.mjs。
import { fill, near } from "./layout.mjs";

const scope = (page) => page.getByRole("button", { name: "改动范围" });
const fileList = (page) => page.getByRole("complementary", { name: "文件列表" });
const tree = (page) => page.getByRole("tree", { name: "审查改动文件" });
const node = (page, path) => tree(page).getByRole("treeitem", { name: path, exact: true });
const card = (page, path) => page.getByRole("button", { name: path, exact: true });

export const checks = [
  {
    id: "review-shows-changes",
    flow: "window.review",
    async run({ open, expect }) {
      const page = await open("window.review");
      await expect(page.getByRole("tab", { name: "审查", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.getByRole("group", { name: "审查来源" })).toBeVisible();
      await expect(scope(page)).toContainText("上一轮");
      await expect(page.getByRole("group", { name: "审查来源" })).toContainText("+19");
      for (const path of ["src/math.ts", "src/math.test.ts"])
        await expect(card(page, path)).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByText("2 行未改动")).toBeVisible();
      await expect(page.getByRole("button", { name: "展开下方未改动行" })).toBeVisible();
      await expect(page.getByRole("button", { name: "显示文件" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    },
  },
  {
    id: "review-scope-menu",
    flow: "window.review → window.review-scope-menu → window.review",
    async run({ open, expect }) {
      const page = await open("window.review");
      await scope(page).click();
      const menu = page.getByRole("menu");
      for (const name of ["上一轮", "未提交的更改", "未暂存的更改", "已暂存的更改", "分支比较"])
        await expect(menu.getByRole("menuitem", { name, exact: true })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "已提交的更改" })).toHaveAttribute(
        "aria-haspopup",
        "menu",
      );
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(scope(page)).toBeFocused();
    },
  },
  {
    id: "review-file-collapse",
    flow: "window.review → window.review",
    async run({ open, expect }) {
      const page = await open("window.review");
      await card(page, "src/math.ts").click();
      await expect(card(page, "src/math.ts")).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByText("2 行未改动")).toBeHidden();
      await expect(card(page, "src/math.test.ts")).toHaveAttribute("aria-expanded", "true");
      await card(page, "src/math.ts").click();
      await expect(page.getByText("2 行未改动")).toBeVisible();
    },
  },
  {
    id: "review-file-list",
    flow: "window.review → window.review-files → window.review",
    async run({ open, expect }) {
      const page = await open("window.review");
      await page.getByRole("button", { name: "显示文件" }).click();
      await expect(fileList(page)).toBeVisible();
      await expect(page.getByRole("button", { name: "隐藏文件" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(node(page, "src")).toHaveAttribute("aria-expanded", "true");
      await expect(node(page, "src/math.ts")).toHaveAttribute("aria-selected", "true");
      await expect(node(page, "src/math.test.ts")).toContainText("+14");
      await expect(page.getByRole("separator", { name: "调整审查文件列表宽度" })).toBeVisible();
      await page.getByRole("button", { name: "隐藏文件" }).click();
      await expect(fileList(page)).toBeHidden();
    },
  },
  {
    id: "review-file-list-select-and-filter",
    flow: "window.review-files → window.review-files",
    async run({ open, expect }) {
      const page = await open("window.review-files");
      const filter = page.getByRole("textbox", { name: "筛选文件" });
      await node(page, "src/math.test.ts").click();
      await expect(node(page, "src/math.test.ts")).toHaveAttribute("aria-selected", "true");
      await expect(filter).toHaveText("src/math.test.ts");
      await expect(card(page, "src/math.ts")).toHaveCount(0);
      await expect(card(page, "src/math.test.ts")).toBeVisible();
      await page.getByRole("button", { name: "清除文件筛选" }).click();
      await expect(card(page, "src/math.ts")).toBeVisible();
      await filter.fill("test");
      await expect(node(page, "src/math.ts")).toHaveCount(0);
      await expect(node(page, "src/math.test.ts")).toBeVisible();
      await page.getByRole("button", { name: "清除文件筛选" }).click();
      await expect(node(page, "src/math.ts")).toBeVisible();
    },
  },
  {
    id: "review-unchanged-fill",
    flow: "window.review（浅色与深色）",
    async run({ open, expect }) {
      // 正文底色 #ffffff / #181818 在 lab 里混入百分之四的黑 / 百分之十五的白。
      for (const [theme, expected] of [
        ["light", 243],
        ["dark", 53],
      ]) {
        const page = await open("window.review", theme);
        const label = page.getByText(/^\d+ 行未改动$/);
        await expect(label).toBeVisible();
        near(`未改动行底色（${theme}）`, await fill(label), [expected, expected, expected], 2);
      }
    },
  },
];
