// GUI L2/L3 自动化巡检探针：在真实浏览器中对设计系统预览执行多视图亮暗/宽窄/18px 定量扫描、
// Web Animations API 动效与 reduced-motion 采集，并生成带编号的 Contact Sheet 供视觉审查。
// 先运行 pnpm --dir clients/gui design:build，再运行：
//   pnpm --dir clients/gui audit:ui [-- --out <证据目录>]
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(gui, "dist/design-system");
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");

const outArgIndex = process.argv.indexOf("--out");
const outDir =
  outArgIndex > 0 && process.argv[outArgIndex + 1]
    ? resolve(process.argv[outArgIndex + 1])
    : await mkdtemp(join(tmpdir(), "areal-ui-audit-"));
await mkdir(outDir, { recursive: true });

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://local").pathname);
    const filePath = resolve(dist, `.${pathname}`);
    if (!filePath.startsWith(dist + sep)) throw new Error("invalid path");
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
      }[extname(filePath)] ?? "application/octet-stream",
    );
    res.end(await readFile(filePath));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

async function openRoute(
  context,
  route,
  { dark = false, width = 1280, height = 800, fontSize = 14 } = {},
) {
  const page = await context.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });

  await page.addInitScript(
    ({ dark, fontSize }) => {
      window.__clsTotal = 0;
      window.__clsEntries = [];
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) {
              window.__clsTotal += entry.value;
              window.__clsEntries.push({
                value: Number(entry.value.toFixed(4)),
                t: Math.round(entry.startTime),
              });
            }
          }
        }).observe({ type: "layout-shift", buffered: true });
      } catch {}

      window.__animEvents = [];
      const rec = (type) => (e) => {
        const el = e.target;
        window.__animEvents.push({
          type,
          name: e.animationName || e.propertyName || "",
          elapsedTime: e.elapsedTime,
          target: el?.tagName
            ? `${el.tagName.toLowerCase()}.${typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""}`
            : "unknown",
        });
      };
      for (const ev of ["transitionrun", "transitionend", "animationstart", "animationend"]) {
        document.addEventListener(ev, rec(ev), true);
      }
      try {
        localStorage.setItem(
          "areal:application-preferences",
          JSON.stringify({ theme: dark ? "dark" : "light", fontSize, chatFontSize: fontSize }),
        );
      } catch {}
    },
    { dark, fontSize },
  );

  await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
  await page.goto(`${origin}/design-system.html${route}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);

  // 通过预览页内置主题/字号下拉控件切换（若存在），确保 React 主题状态真实生效。
  if (dark) {
    const themeSelect = page
      .locator("select")
      .filter({ hasText: /深色/ })
      .first();
    if (await themeSelect.count()) {
      await themeSelect.selectOption({ label: "深色" }).catch(() => {});
    }
  }
  if (fontSize !== 14) {
    const fontSelect = page
      .locator("select")
      .filter({ hasText: new RegExp(String(fontSize)) })
      .first();
    if (await fontSelect.count()) {
      await fontSelect.selectOption({ label: String(fontSize) }).catch(() => {});
    }
  }
  await page.waitForTimeout(150);
  // 切换主题/字号下拉是脚本模拟的用户偏好设置，之后重置 CLS 计数以测量稳态下的真实布局偏移。
  await page.evaluate(() => {
    window.__clsTotal = 0;
    window.__clsEntries = [];
  });
  await page.waitForTimeout(200);
  return { page, errors };
}

async function measureLayout(page, label) {
  return await page.evaluate((label) => {
    const docOverflowX =
      document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const clippedButtons = [];
    for (const btn of document.querySelectorAll("button, [role='tab'], [role='menuitem'], a")) {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const cs = getComputedStyle(btn);
      if (cs.visibility === "hidden" || cs.opacity === "0") continue;
      const text = (btn.innerText || "").trim();
      if (!text) continue;
      if (btn.scrollWidth > btn.clientWidth + 2) {
        clippedButtons.push({
          text: text.slice(0, 40),
          overflowPx: Math.round(btn.scrollWidth - btn.clientWidth),
        });
      }
    }
    return {
      label,
      docOverflowX,
      clsTotal: Number((window.__clsTotal || 0).toFixed(4)),
      clippedButtonsCount: clippedButtons.length,
      clippedButtons: clippedButtons.slice(0, 8),
    };
  }, label);
}

/** 将多张截图按 contact-sheet-review 规范合成带编号标签的总览 PNG。 */
export async function buildContactSheet(context, { filename, title, cols = 2, items }) {
  const page = await context.newPage({
    viewport: { width: cols * 660 + 48, height: 1000 },
    deviceScaleFactor: 1,
  });
  const cardsHtml = await Promise.all(
    items.map(async (item, idx) => {
      const b64 = (await readFile(item.path)).toString("base64");
      return `
        <div class="card">
          <div class="meta"><span class="idx">#${String(idx + 1).padStart(2, "0")}</span> ${item.caption}</div>
          <div class="img-wrap"><img src="data:image/png;base64,${b64}" /></div>
        </div>
      `;
    }),
  );
  await page.setContent(`<!doctype html><html><head><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #14161a; color: #e8eaed; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; padding: 20px; }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 14px; color: #fff; }
    .grid { display: grid; grid-template-columns: repeat(${cols}, 640px); gap: 16px; }
    .card { background: #1e2128; border: 1px solid #303642; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; }
    .meta { padding: 8px 12px; font-size: 13px; font-weight: 500; background: #262a34; border-bottom: 1px solid #303642; color: #d6dce6; }
    .idx { display: inline-block; background: #3a83f7; color: #fff; padding: 1px 6px; border-radius: 4px; margin-right: 6px; font-family: ui-monospace, monospace; font-size: 12px; }
    .img-wrap { padding: 8px; background: #0f1115; display: flex; align-items: center; justify-content: center; }
    img { max-width: 100%; max-height: 440px; width: auto; height: auto; display: block; border: 1px solid #2b303a; }
  </style></head><body><h1>${title}</h1><div class="grid">${cardsHtml.join("")}</div></body></html>`);
  await page.waitForTimeout(150);
  const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: cols * 660 + 48, height: Math.min(fullHeight + 20, 4800) });
  const outPath = join(outDir, filename);
  await page.screenshot({ path: outPath, fullPage: true });
  await page.close();
  return outPath;
}

const report = { outDir, layoutAudit: [], motionProbe: [], consoleErrors: [], sheets: [] };
const context = await browser.newContext();

try {
  const views = [
    {
      id: "content-light-wide",
      route: "?content-system",
      dark: false,
      width: 1280,
      height: 800,
      fontSize: 14,
      caption: "Content System | Light 1280 14px",
    },
    {
      id: "content-dark-wide",
      route: "?content-system",
      dark: true,
      width: 1280,
      height: 800,
      fontSize: 14,
      caption: "Content System | Dark 1280 14px",
    },
    {
      id: "settings-light-wide",
      route: "?settings-exercise",
      dark: false,
      width: 1280,
      height: 800,
      fontSize: 14,
      caption: "Settings | Light 1280 14px",
    },
    {
      id: "settings-dark-wide",
      route: "?settings-exercise",
      dark: true,
      width: 1280,
      height: 800,
      fontSize: 14,
      caption: "Settings | Dark 1280 14px",
    },
    {
      id: "settings-light-narrow18",
      route: "?settings-exercise",
      dark: false,
      width: 420,
      height: 800,
      fontSize: 18,
      caption: "Settings | Light 420 18px",
    },
    {
      id: "settings-dark-narrow18",
      route: "?settings-exercise",
      dark: true,
      width: 420,
      height: 800,
      fontSize: 18,
      caption: "Settings | Dark 420 18px",
    },
  ];

  const captured = [];
  for (const item of views) {
    const { page, errors } = await openRoute(context, item.route, item);
    if (errors.length) report.consoleErrors.push({ id: item.id, errors });
    report.layoutAudit.push(await measureLayout(page, item.id));
    const path = join(outDir, `${item.id}.png`);
    await page.screenshot({ path });
    captured.push({ ...item, path });
    await page.close();
  }

  // 动效与 reduced-motion 运行时采样
  for (const reducedMotion of [false, true]) {
    const { page } = await openRoute(context, "?ui-library", {
      dark: false,
      width: 1280,
      height: 800,
    });
    if (reducedMotion) {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.evaluate(() => {
        document.documentElement.dataset.reducedMotion = "true";
      });
    }
    await page.evaluate(() => {
      window.__animEvents = [];
    });
    const trigger = page.locator("button[aria-haspopup='menu']").first();
    if (await trigger.count()) await trigger.click();
    await page.waitForTimeout(30);
    const anims = await page.evaluate(() =>
      document.getAnimations().map((a) => ({
        name: a.animationName || a.transitionProperty || "web-anim",
        duration: a.effect?.getTiming?.().duration,
      })),
    );
    await page.waitForTimeout(220);
    const events = await page.evaluate(() => window.__animEvents);
    report.motionProbe.push({
      id: reducedMotion ? "menu-reduced" : "menu-normal",
      reducedMotion,
      anims,
      events,
    });
    await page.close();
  }

  const sheetPath = await buildContactSheet(context, {
    filename: "contact-sheet-overview.png",
    title: "UI Audit Overview — Light/Dark & Wide(14px)/Narrow(420px, 18px)",
    cols: 2,
    items: captured,
  });
  report.sheets.push(sheetPath);

  await writeFile(join(outDir, "ui-audit-report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      passed: report.consoleErrors.length === 0,
      outDir,
      views: report.layoutAudit.length,
      maxOverflowX: Math.max(0, ...report.layoutAudit.map((r) => r.docOverflowX)),
      maxCls: Math.max(0, ...report.layoutAudit.map((r) => r.clsTotal)),
      reducedMotionAnims: report.motionProbe.find((m) => m.reducedMotion)?.anims.length ?? 0,
      sheets: report.sheets,
    }),
  );
} finally {
  await browser.close();
  server.close();
}
