// 用法：node design/spec/conformance/run.mjs --url <入口 URL> [--browser <chromium 路径>]
// 需要能从当前目录解析到 playwright 或 playwright-core；断言是下面的最小实现，不依赖测试框架。
import { createRequire } from "node:module";
import { checks as decide } from "./decide.mjs";
import { checks as navigate } from "./navigate.mjs";
import { checks as overlays } from "./overlays.mjs";
import { checks as sendRunStop } from "./send-run-stop.mjs";
import { checks as settings } from "./settings.mjs";
import { checks as panel } from "./panel.mjs";

const checks = [...sendRunStop, ...decide, ...navigate, ...overlays, ...settings, ...panel];

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const url = process.argv.includes("--url") ? arg("--url") : undefined;
if (!url) throw new Error("--url is required");
const require = createRequire(`${process.cwd()}/`);
const load = (name) => {
  try {
    return require(name);
  } catch {
    return undefined;
  }
};
const playwright = load("playwright") ?? load("playwright-core");
if (!playwright) throw new Error("install playwright or playwright-core where you run this");

const TIMEOUT = 5000;
async function until(describe, test) {
  const deadline = Date.now() + TIMEOUT;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await test()) return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`expected ${describe}${last ? ` (${last.message})` : ""}`);
}
const expect = (locator) => ({
  toBeVisible: () => until(`${locator} visible`, () => locator.first().isVisible()),
  toBeEnabled: () => until(`${locator} enabled`, () => locator.first().isEnabled()),
  toBeDisabled: () => until(`${locator} disabled`, () => locator.first().isDisabled()),
  toBeHidden: () => until(`${locator} hidden`, async () => !(await locator.first().isVisible())),
  toBeFocused: () =>
    until(`${locator} focused`, () => locator.first().evaluate((node) => node === document.activeElement)),
  toHaveAttribute: (name, value) =>
    until(`${locator} [${name}="${value}"]`, async () =>
      (await locator.first().getAttribute(name)) === value,
    ),
  toHaveCount: (count) =>
    until(`${locator} count ${count}`, async () => (await locator.count()) === count),
  toContainText: (text) =>
    until(`${locator} to contain "${text}"`, async () =>
      (await locator.first().textContent()).includes(text),
    ),
  // 输入框可以是 textarea，也可以是可编辑区域；两种都按可见内容比较。
  toHaveText: (text) =>
    until(`${locator} to have "${text}"`, async () => {
      const element = locator.first();
      const value = await element.evaluate((node) =>
        "value" in node ? node.value : node.textContent,
      );
      return value.trim() === text;
    }),
});
const browser = await playwright.chromium.launch({
  ...(process.argv.includes("--browser") ? { executablePath: arg("--browser") } : {}),
  args: ["--no-sandbox"],
});
let passed = 0;
for (const check of checks) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "zh-CN",
  });
  const open = async (state, theme = "light") => {
    const page = await context.newPage();
    const target = new URL(url);
    target.searchParams.set("state", state);
    target.searchParams.set("theme", theme);
    await page.goto(target.href);
    return page;
  };
  try {
    await check.run({ open, expect });
    passed += 1;
    console.log(`✓ ${check.id}`);
  } catch (error) {
    console.log(`✗ ${check.id} (${check.flow}): ${String(error.message).split("\n")[0]}`);
  }
  await context.close();
}
await browser.close();
console.log(`conformance: ${passed}/${checks.length} passed`);
process.exitCode = passed === checks.length ? 0 : 1;
