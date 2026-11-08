// 文件面板的行为验收。约定同 send-run-stop.mjs。
const tree = (page) => page.getByRole("tree", { name: "工作区文件" });
const node = (page, path) => tree(page).getByRole("treeitem", { name: path, exact: true });
const tab = (page, name) =>
  page.getByRole("tablist", { name: "侧边面板标签" }).getByRole("tab", { name, exact: true });

export const checks = [
  {
    id: "files-tree",
    flow: "window.files",
    async run({ open, expect }) {
      const page = await open("window.files");
      await expect(tab(page, "文件")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("textbox", { name: "搜索文件" })).toBeVisible();
      await expect(page.getByRole("button", { name: "文件树更多" })).toBeVisible();
      for (const path of ["src", "package.json", "README.md"])
        await expect(node(page, path)).toBeVisible();
      await expect(node(page, "src")).toHaveAttribute("aria-expanded", "false");
      await expect(node(page, "src")).toContainText("●");
    },
  },
  {
    id: "files-expand-shows-changes",
    flow: "window.files → window.files",
    async run({ open, expect }) {
      const page = await open("window.files");
      await node(page, "src").click();
      await expect(node(page, "src")).toHaveAttribute("aria-expanded", "true");
      await expect(node(page, "src/math.ts")).toContainText("M");
      await expect(node(page, "src/math.test.ts")).toContainText("A");
      await expect(node(page, "src/index.ts")).toBeVisible();
      await node(page, "src").click();
      await expect(node(page, "src/math.ts")).toHaveCount(0);
    },
  },
  {
    id: "files-open-file",
    flow: "window.files → window.files-open",
    async run({ open, expect }) {
      const page = await open("window.files");
      await node(page, "src").click();
      await node(page, "src/math.ts").click();
      await expect(tab(page, "math.ts")).toHaveAttribute("aria-selected", "true");
      await expect(tab(page, "文件")).toHaveAttribute("aria-selected", "false");
      await expect(page.getByRole("navigation", { name: "文件路径" })).toContainText("math.ts");
      await expect(node(page, "src/math.ts")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("button", { name: "切换文件树" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    },
  },
  {
    id: "files-keyboard",
    flow: "window.files → window.files-open",
    async run({ open, expect }) {
      const page = await open("window.files");
      await node(page, "src").focus();
      await page.keyboard.press("ArrowRight");
      await expect(node(page, "src")).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("ArrowDown");
      await expect(node(page, "src/index.ts")).toBeFocused();
      await page.keyboard.press("End");
      await expect(node(page, "README.md")).toBeFocused();
      await node(page, "src/math.ts").focus();
      await page.keyboard.press("Enter");
      await expect(tab(page, "math.ts")).toHaveAttribute("aria-selected", "true");
    },
  },
  {
    id: "files-toggle-tree",
    flow: "window.files-open → window.files-open",
    async run({ open, expect }) {
      const page = await open("window.files-open");
      const toggle = page.getByRole("button", { name: "切换文件树" });
      await expect(node(page, "src/math.ts")).toHaveAttribute("aria-selected", "true");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(tree(page)).toBeHidden();
      await expect(page.getByRole("navigation", { name: "文件路径" })).toBeVisible();
      await toggle.click();
      await expect(tree(page)).toBeVisible();
    },
  },
];
