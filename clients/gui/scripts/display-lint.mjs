import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 显示问题巡检：在规格入口的每个示例状态（浅色、深色）里找肉眼一看就是错的布局。
// 用法：node scripts/display-lint.mjs --url <规格入口 URL> [--browser <chromium 路径>]
const gui = fileURLToPath(new URL("../", import.meta.url));
const fixture = JSON.parse(
  await readFile(resolve(gui, "../../design/spec/fixtures/send-run-stop.json"), "utf8"),
);

/** 在页面里运行：返回这一屏的显示问题。只看可见元素，不依赖类名。 */
export function findDisplayProblems() {
  const problems = [];
  const visible = (element) =>
    element.getBoundingClientRect().width > 0 &&
    element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const label = (element) =>
    (element.getAttribute("aria-label") || element.textContent || element.tagName)
      .trim()
      .slice(0, 40);
  for (const element of document.querySelectorAll("body *")) {
    if (!visible(element)) continue;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    // 空容器：有上下边框、比两条边框还矮、没有内容，看上去就是一条多余的线。
    const top = parseFloat(style.borderTopWidth),
      bottom = parseFloat(style.borderBottomWidth);
    if (
      top > 0 &&
      bottom > 0 &&
      box.width > 40 &&
      box.height <= top + bottom + 1 &&
      !element.textContent.trim() &&
      !element.querySelector("img, svg, input, canvas")
    )
      problems.push({ rule: "empty-box", target: element.className || element.tagName });
    // 一组并排的按钮折成多行：按钮所在的行放不下，应改布局而不是让按钮掉到下一行。
    const buttons = [...element.children].filter(
      (child) =>
        child.matches("button, [role=button]") &&
        visible(child) &&
        !["absolute", "fixed"].includes(getComputedStyle(child).position),
    );
    if (buttons.length >= 2 && style.display.includes("flex") && style.flexDirection === "row") {
      const boxes = buttons.map((button) => button.getBoundingClientRect());
      const wrapped = boxes.some((box) => boxes.some((other) => box.top >= other.bottom - 1));
      if (wrapped)
        problems.push({ rule: "wrapped-buttons", target: buttons.map(label).join(" / ") });
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
  const url = arg("--url");
  if (!url || !process.argv.includes("--url")) throw new Error("--url is required");
  const require = createRequire(`${process.cwd()}/`);
  let playwright;
  for (const name of ["playwright", "playwright-core"])
    try {
      playwright ??= require(name);
    } catch {}
  const browser = await playwright.chromium.launch({
    ...(process.argv.includes("--browser") ? { executablePath: arg("--browser") } : {}),
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  let total = 0;
  for (const state of Object.keys(fixture.states))
    for (const theme of ["light", "dark"]) {
      const target = new URL(url);
      target.searchParams.set("state", state);
      target.searchParams.set("theme", theme);
      await page.goto(target.href);
      await page.waitForTimeout(800);
      const problems = await page.evaluate(findDisplayProblems);
      for (const item of problems) console.error(`${state}.${theme}: ${item.rule} ${item.target}`);
      total += problems.length;
    }
  await browser.close();
  if (total) {
    console.error(`display: ${total} problems.`);
    process.exit(1);
  }
  console.log(`display: ${Object.keys(fixture.states).length} states clean in both themes.`);
}
