// 用法：node design/spec/conformance/run.mjs --url <入口 URL> [--browser <chromium 路径>]
// 需要能从当前目录解析到 playwright 或 playwright-core；断言是下面的最小实现，不依赖测试框架。
import { createRequire } from "node:module";
import { checks } from "./send-run-stop.mjs";

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
  toContainText: (text) =>
    until(`${locator} to contain "${text}"`, async () => (await locator.first().textContent()).includes(text)),
  toHaveText: (text) =>
    until(`${locator} to have "${text}"`, async () => (await locator.first().textContent()).trim() === text),
});
const browser = await playwright.chromium.launch({
  ...(process.argv.includes("--browser") ? { executablePath: arg("--browser") } : {}),
  args: ["--no-sandbox"],
});
let passed = 0;
for (const check of checks) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
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
