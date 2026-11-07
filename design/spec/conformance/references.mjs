// 标准截图：node design/spec/conformance/references.mjs --url <入口 URL> [--write] [--out <目录>] [--browser <路径>] [--threshold <比例>]
// 不带 --write 时与 references/ 逐张比较，差异像素超过阈值即失败；带 --write 时重新生成。
// 字体和渲染环境不同会产生差异，基线只在同一环境下更新，并随 PR 说明。
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHOTS = [
  "home.empty",
  "home.draft",
  "home.tooltip",
  "thread.idle",
  "thread.running",
  "thread.queued",
  "thread.stopped",
  "thread.approval",
  "thread.question",
  "window.sidebar",
  "window.collapsed",
  "window.search",
  "window.search-query",
  "window.rail",
  "window.task-menu",
  "window.organize-menu",
  "window.rename",
  "window.settings",
  "window.settings-appearance",
  "window.settings-search",
  "window.settings-select",
].flatMap((state) => ["light", "dark"].map((theme) => ({ state, theme })));
// 本仓库防回归用 0.001；交接演练首轮另按 --threshold 0.01 计分。
const THRESHOLD = process.argv.includes("--threshold")
  ? Number(process.argv[process.argv.indexOf("--threshold") + 1])
  : 0.001;

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const url = process.argv.includes("--url") ? arg("--url") : undefined;
if (!url) throw new Error("--url is required");
const write = process.argv.includes("--write");
const references = join(dirname(fileURLToPath(import.meta.url)), "../references");
const out = process.argv.includes("--out") ? arg("--out") : references;
const require = createRequire(`${process.cwd()}/`);
let playwright;
for (const name of ["playwright", "playwright-core"])
  try {
    playwright ??= require(name);
  } catch {}
if (!playwright) throw new Error("install playwright or playwright-core where you run this");
const browser = await playwright.chromium.launch({
  ...(process.argv.includes("--browser") ? { executablePath: arg("--browser") } : {}),
  args: ["--no-sandbox", "--font-render-hinting=none"],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  locale: "zh-CN",
  timezoneId: "UTC",
  reducedMotion: "reduce",
});
const page = await context.newPage();

async function difference(a, b) {
  return page.evaluate(
    async ([a, b]) => {
      const load = (data) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = `data:image/png;base64,${data}`;
        });
      const [left, right] = await Promise.all([load(a), load(b)]);
      if (left.width !== right.width || left.height !== right.height) return 1;
      const pixels = (image) => {
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const x = pixels(left);
      const y = pixels(right);
      let changed = 0;
      for (let i = 0; i < x.length; i += 4)
        if (
          Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) >
          48
        )
          changed += 1;
      return changed / (x.length / 4);
    },
    [a.toString("base64"), b.toString("base64")],
  );
}

let failed = 0;
await mkdir(out, { recursive: true });
for (const { state, theme } of SHOTS) {
  const target = new URL(url);
  target.searchParams.set("state", state);
  target.searchParams.set("theme", theme);
  await page.goto(target.href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1000);
  const shot = await page.screenshot({ animations: "disabled", caret: "hide" });
  const name = `${state}.${theme}.png`;
  if (write) {
    await writeFile(join(out, name), shot);
    console.log(`wrote ${name}`);
    continue;
  }
  const expected = await readFile(join(references, name)).catch(() => undefined);
  const ratio = expected ? await difference(expected, shot) : 1;
  if (out !== references) await writeFile(join(out, name), shot);
  if (ratio > THRESHOLD) failed += 1;
  console.log(`${ratio > THRESHOLD ? "✗" : "✓"} ${name} ${(ratio * 100).toFixed(2)}% differs`);
}
await browser.close();
if (!write) console.log(`references: ${SHOTS.length - failed}/${SHOTS.length} match`);
process.exitCode = failed ? 1 : 0;
