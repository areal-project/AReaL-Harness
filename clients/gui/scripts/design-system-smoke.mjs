import { runAccessibilityKeyboard } from "./design-system-keyboard.mjs";
import { runAccessibility } from "./design-system-accessibility.mjs";
import { runContentSystem } from "./design-system-content.mjs";
import { runReuseExercise } from "./design-system-reuse-exercise.mjs";
import { runProductCandidate } from "./design-system-product-candidate.mjs";
import { runDesignDocuments } from "./design-system-documents.mjs";
import { runSharedWorkspace } from "./design-system-shared-workspace.mjs";
import { runConversationExercise } from "./design-system-conversation-exercise.mjs";
import { runConversationDemo } from "./design-system-conversation-demo.mjs";
import { runConversationSystem } from "./design-system-conversation-system.mjs";
import { runPopupAnchors } from "./design-system-popup-anchors.mjs";
import { runUiLibrary } from "./design-system-library.mjs";
import { runDecisionExercise } from "./design-system-decision-exercise.mjs";
import { runSettingsExercise, runSettingsContrast } from "./design-system-settings-exercise.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// 检查真实生产组件的渲染与局部交互；Core/原生行为由现有桌面 smoke 负责。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");
const dist = join(gui, "dist/design-system");
const scratch = await mkdtemp(join(tmpdir(), "areal-design-system-"));
const baseline = process.argv.includes("--baseline");
const accessibilityOnly = process.argv.includes("--accessibility");
const keyboardOnly = process.argv.includes("--keyboard-only");
const conversationExercise = process.argv.includes("--conversation-exercise");
const conversationDemo = process.argv.includes("--conversation-demo");
const conversationSystem = process.argv.includes("--conversation-system");
const contentSystem = process.argv.includes("--content-system");
const popupAnchors = process.argv.includes("--popup-anchors");
const uiLibrary = process.argv.includes("--ui-library");
const decisionExercise = process.argv.includes("--decision-exercise");
const settingsContrast = process.argv.includes("--settings-contrast");
const settingsExercise = process.argv.includes("--settings-exercise") || settingsContrast;
const sharedWorkspace = process.argv.includes("--shared-workspace");
const documents = process.argv.includes("--documents");
const productCandidate = process.argv.includes("--product-candidate");
const reuseExercise = process.argv.includes("--reuse-exercise");
const namedExercise =
  accessibilityOnly ||
  keyboardOnly ||
  contentSystem ||
  reuseExercise ||
  productCandidate ||
  documents ||
  sharedWorkspace ||
  conversationExercise ||
  conversationDemo ||
  conversationSystem ||
  uiLibrary ||
  popupAnchors ||
  decisionExercise ||
  settingsExercise;
const exercise = { steps: [], checks: [] };
const settingsOnly = process.argv.includes("--settings-only");
const html = await readFile(join(dist, "design-system.html"), "utf8");
const buildDigest = createHash("sha256").update(html);
for (const match of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g))
  buildDigest.update(await readFile(join(dist, match[1])));
const buildSha256 = buildDigest.digest("hex");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gui }).toString().trim();
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://local").pathname);
    const path = resolve(dist, `.${pathname}`);
    if (!path.startsWith(dist + sep)) throw new Error("invalid asset path");
    response.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
      }[extname(path)] ?? "application/octet-stream",
    );
    response.end(await readFile(path));
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser,
  page,
  passed = false;
const errors = [],
  external = [],
  samples = [],
  checks = [];
async function settingsChecks() {
  const preview = page.getByRole("region", { name: "设置组合预览", exact: true });
  const host = (name) => page.locator(`[data-settings-host="${name}"]`);
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const measure = (locator) =>
    locator.evaluate((el) => {
      const css = getComputedStyle(el),
        rect = el.getBoundingClientRect();
      const separator = getComputedStyle(el.querySelector(".settings-field-row"), "::after");
      const title = getComputedStyle(
        el.closest(".settings-section").querySelector(".settings-section-title"),
      );
      const description = getComputedStyle(
        el.closest(".settings-section").querySelector(".settings-section-desc"),
      );
      const row = getComputedStyle(el.querySelector(".settings-field-row"));
      const layout = getComputedStyle(el.querySelector(".settings-field-layout"));
      const wide = getComputedStyle(el.querySelector(".settings-field-layout-wide"));
      const text = getComputedStyle(el.querySelector('input[type="text"]'));
      const probe = document.createElement("span");
      probe.style.background = "var(--color-settings-card)";
      probe.style.color = "var(--color-settings-secondary)";
      el.append(probe);
      const semantic = {
        background: getComputedStyle(probe).backgroundColor,
        secondary: getComputedStyle(probe).color,
      };
      probe.remove();
      return {
        radius: css.borderRadius,
        background: css.backgroundColor,
        semantic,
        width: rect.width,
        title: {
          font: title.fontSize,
          weight: title.fontWeight,
          margin: title.margin,
          line: title.lineHeight,
        },
        description: {
          font: description.fontSize,
          color: description.color,
          margin: description.margin,
        },
        row: { minHeight: row.minHeight, padding: row.padding },
        separator: {
          height: separator.height,
          content: separator.content,
          left: separator.left,
          right: separator.right,
        },
        columns: layout.gridTemplateColumns.split(" ").length,
        wideColumns: wide.gridTemplateColumns.split(" "),
        nativeText: { font: text.fontSize, height: text.height },
        overflow: [
          ...el.querySelectorAll(
            ".settings-field-row, .settings-field-label, .settings-field-description",
          ),
        ]
          .filter((node) => node.scrollWidth > node.clientWidth + 1)
          .map((node) => ({
            className: node.className,
            width: node.clientWidth,
            scroll: node.scrollWidth,
          })),
        bounds: [
          ...el.querySelectorAll(
            ".settings-field-layout, .settings-field-control, .settings-field-control > *",
          ),
        ]
          .filter((node) => {
            const box = node.getBoundingClientRect();
            return (
              !node.matches('input[aria-hidden="true"][tabindex="-1"]') &&
              (box.left < rect.left - 1 || box.right > rect.right + 1)
            );
          })
          .map((node) => ({
            tag: node.tagName,
            className: node.className,
            html: node.outerHTML.slice(0, 250),
            rect: {
              left: node.getBoundingClientRect().left,
              right: node.getBoundingClientRect().right,
            },
            card: { left: rect.left, right: rect.right },
          })),
        cardOverflow: el.scrollWidth > el.clientWidth + 1,
      };
    });
  for (const sample of [
    { theme: "light", font: "14", width: "wide" },
    { theme: "dark", font: "14", width: "wide" },
    { theme: "light", font: "18", width: "narrow" },
    { theme: "dark", font: "18", width: "narrow" },
  ]) {
    await page.setViewportSize({ width: sample.width === "wide" ? 1440 : 420, height: 900 });
    await page.getByLabel("主题", { exact: true }).selectOption(sample.theme);
    await page.getByLabel("字号", { exact: true }).selectOption(sample.font);
    await page.getByLabel("面板宽度", { exact: true }).selectOption(sample.width);
    await settle();
    const observations = {};
    const assertCard = (value, name) => {
      assert.equal(value.radius, "20px", `${name} uses the overlay radius`);
      assert.equal(
        value.background,
        value.semantic.background,
        `${name} consumes the settings card semantic background`,
      );
      assert.equal(value.title.font, `${sample.font}px`);
      assert.equal(value.title.weight, "500");
      assert.equal(value.title.margin, "0px");
      assert.equal(value.title.line, "21px");
      assert.equal(value.description.font, `${Number(sample.font) - 2}px`);
      assert.equal(value.description.color, value.semantic.secondary);
      assert.equal(value.description.margin, "2px 0px 0px");
      assert.equal(value.row.minHeight, "48px");
      assert.equal(value.row.padding, "12px 16px");
      assert.deepEqual(value.separator, {
        height: "0.5px",
        content: '""',
        left: "16px",
        right: "16px",
      });
      assert.equal(
        value.columns,
        sample.width === "wide" ? 2 : 1,
        `${name} stacks at the card container boundary`,
      );
      assert.equal(value.wideColumns.length, sample.width === "wide" ? 2 : 1);
      if (sample.width === "wide")
        assert.equal(value.wideColumns[1], "280px", `${name} keeps the wide control column`);
      assert.deepEqual(value.nativeText, {
        font: `${Number(sample.font) - 1}px`,
        height: `${Number(sample.font) + 14}px`,
      });
      assert.deepEqual(
        value.overflow,
        [],
        `${name} retains long Chinese and English without horizontal overflow`,
      );
      assert.deepEqual(value.bounds, [], `${name} keeps controls and their layout inside the card`);
      assert.equal(value.cardOverflow, false, `${name} has no card overflow`);
    };
    for (const name of ["standalone", "page"]) {
      observations[name] = await measure(host(name).locator(".settings-group-card"));
      assertCard(observations[name], name);
    }
    const compact = await host("compact")
      .locator(".settings-field-row")
      .first()
      .evaluate((el) => ({
        minHeight: getComputedStyle(el).minHeight,
        top: getComputedStyle(el).paddingTop,
        bottom: getComputedStyle(el).paddingBottom,
      }));
    assert.deepEqual(compact, { minHeight: "40px", top: "8px", bottom: "8px" });
    const mobile = await host("mobile")
      .locator(".remote-access-panel")
      .evaluate((el) => {
        const child = el.firstElementChild;
        return {
          direct: child.matches('[data-slot="card-content"]'),
          padding: getComputedStyle(child).padding,
          display: getComputedStyle(child).display,
        };
      });
    assert.deepEqual(
      mobile,
      { direct: true, padding: "16px", display: "flex" },
      "the real Mobile stylesheet retains its direct content slot and padding",
    );
    assert.equal(
      await preview.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      true,
      "settings gallery does not overflow",
    );
    await preview.getByRole("button", { name: "打开设置弹窗", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "设置弹窗预览", exact: true });
    await dialog.waitFor();
    assert.equal(
      await dialog.evaluate((el) => !el.closest(".design-preview")),
      true,
      "SettingsDialog is rendered through the production portal",
    );
    observations.dialog = await measure(host("dialog").locator(".settings-group-card"));
    assertCard(observations.dialog, "dialog");
    await dialog.screenshot({
      path: join(scratch, `settings-dialog-${sample.theme}-${sample.font}-${sample.width}.png`),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    for (const name of ["standalone", "page", "compact", "mobile", "states"]) {
      await host(name).screenshot({
        path: join(scratch, `settings-${name}-${sample.theme}-${sample.font}-${sample.width}.png`),
        animations: "disabled",
      });
    }
    samples.push({ settings: sample, observations, compact, mobile });
  }
  checks.push(
    "settings standalone, production SettingsPage and portal SettingsDialog share literal 20px radius, semantic backgrounds and section typography across themes/font sizes/widths; compact density, dividers, responsive stacking and Mobile content slot/padding are preserved",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel("主题", { exact: true }).selectOption("light");
  await page.getByLabel("字号", { exact: true }).selectOption("14");
  await page.getByLabel("面板宽度", { exact: true }).selectOption("wide");
  const toggle = host("standalone").getByRole("switch", { name: "独立开关", exact: true });
  await toggle.focus();
  await page.keyboard.press("Space");
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  assert.equal(
    await toggle.evaluate((el) => el === document.activeElement && el.matches(":focus-visible")),
    true,
  );
  const text = host("standalone").getByLabel("独立文本", { exact: true });
  await text.fill("已编辑 Edited");
  await text.press("Tab");
  const number = host("standalone").getByLabel("独立数字", { exact: true });
  assert.equal(await number.evaluate((el) => el === document.activeElement), true);
  await number.press("ArrowUp");
  assert.equal(await number.inputValue(), "4");
  await number.press("Tab");
  const range = host("standalone").getByLabel("独立范围", { exact: true });
  assert.equal(await range.evaluate((el) => el === document.activeElement), true);
  await range.press("ArrowRight");
  assert.equal(await range.inputValue(), "15");
  assert.equal(
    await host("standalone").getByLabel("独立范围值", { exact: true }).innerText(),
    "15",
  );
  await host("standalone").getByRole("combobox", { name: "独立显示模式", exact: true }).click();
  await page
    .locator('[data-slot="select-content"]')
    .getByRole("option", { name: "深色", exact: true })
    .click();
  assert.equal(
    await host("standalone")
      .getByRole("combobox", { name: "独立显示模式", exact: true })
      .innerText(),
    "深色",
  );
  assert.equal(await text.inputValue(), "已编辑 Edited");
  checks.push(
    "shared rows retain keyboard focus and native text/number/range/output values; public custom Select keeps the selected option",
  );
  const draft = host("states").getByLabel("状态草稿", { exact: true });
  await draft.fill("保留我的草稿 Keep draft");
  for (const state of ["disabled", "pending", "failed", "unknown"]) {
    await page.getByLabel("设置展示状态", { exact: true }).selectOption(state);
    assert.equal(await draft.inputValue(), "保留我的草稿 Keep draft");
    const save = host("states").getByRole("button", { name: "保存", exact: true });
    assert.equal(await save.isDisabled(), state !== "failed");
    if (state === "pending") assert.equal(await save.getAttribute("aria-busy"), "true");
    if (state === "failed") {
      await save.click();
      assert.equal(
        await host("states").getByRole("alert").innerText(),
        "示例操作明确失败，草稿已保留。",
      );
    }
    if (state === "unknown")
      assert.equal(
        await host("states").getByRole("status").innerText(),
        "结果待确认，保留当前值；不重复提交。",
      );
  }
  checks.push(
    "external presentation fixtures preserve draft values across unavailable/pending/known failure/unknown states without reporting a successful save",
  );
  const general = host("general");
  await general.getByRole("switch", { name: "底部面板", exact: true }).click();
  await general
    .getByRole("tablist", { name: "默认终端位置", exact: true })
    .getByRole("tab", { name: "底部", exact: true })
    .click();
  await preview.getByRole("button", { name: "重新挂载常规设置", exact: true }).click();
  assert.equal(
    await general
      .getByRole("switch", { name: "底部面板", exact: true })
      .getAttribute("aria-checked"),
    "false",
  );
  assert.equal(
    await general
      .getByRole("tablist", { name: "默认终端位置", exact: true })
      .getByRole("tab", { name: "底部", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  assert.equal(
    await general.getByRole("switch", { name: "运行时防止系统休眠", exact: true }).isDisabled(),
    true,
  );
  assert.deepEqual(
    await page.evaluate(() => {
      const prefs = JSON.parse(localStorage.getItem("areal-gui:application-preferences"));
      return {
        showBottomPanelControl: prefs.showBottomPanelControl,
        terminalLocation: prefs.terminalLocation,
      };
    }),
    { showBottomPanelControl: false, terminalLocation: "bottom" },
  );
  await page.reload();
  assert.equal(
    await general
      .getByRole("switch", { name: "底部面板", exact: true })
      .getAttribute("aria-checked"),
    "false",
  );
  assert.equal(
    await general
      .getByRole("tablist", { name: "默认终端位置", exact: true })
      .getByRole("tab", { name: "底部", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  checks.push(
    "real GeneralSettings writes local preferences through its production controls and retains them after remount/reload in the isolated context; service controls remain unavailable",
  );
  await preview.getByRole("button", { name: "打开设置弹窗", exact: true }).click();
  await page.getByRole("dialog", { name: "设置弹窗预览", exact: true }).waitFor();
  const signature = () =>
    page.evaluate(() =>
      [
        ...document.querySelectorAll(
          "[data-settings-host] .settings-group-card, [data-settings-host] .settings-section-title, [data-settings-host] .settings-section-heading .settings-section-desc, [data-settings-host] .settings-field-row, [data-settings-host] .settings-field-layout, [data-settings-host] .settings-field-control input, [data-settings-host] .settings-group-content",
        ),
      ].map((el) => {
        const css = getComputedStyle(el);
        const separator = getComputedStyle(el, "::after");
        return [
          css.borderRadius,
          css.backgroundColor,
          css.fontSize,
          css.color,
          css.lineHeight,
          css.margin,
          css.padding,
          css.minHeight,
          css.display,
          css.gridTemplateColumns,
          separator.height,
        ];
      }),
    );
  const orders = [];
  for (const width of [1440, 420]) {
    await page.setViewportSize({ width, height: 900 });
    await settle();
    const before = await signature();
    for (const sharedLast of [false, true]) {
      const reordered = await page.evaluate((sharedLast) => {
        const moved = [];
        for (const sheet of document.styleSheets) {
          const selected = [...sheet.cssRules]
            .map((rule, index) => {
              const shared =
                (rule.selectorText &&
                  /\.settings-(?:section\b|group-card\b|group-content\b|field-|locked-value\b)/.test(
                    rule.selectorText,
                  )) ||
                (rule.cssText.startsWith("@container") &&
                  rule.cssText.includes(".settings-field-layout") &&
                  !rule.cssText.includes(".appearance-"));
              const legacy =
                rule.selectorText &&
                /\.settings-page (?:h2|p)(?:[\s,{]|$)|\.design-preview h2|\.settings-sections section|\.remote-access-panel >/.test(
                  rule.selectorText,
                );
              return { rule, index, shared, legacy };
            })
            .filter((entry) => entry.shared || entry.legacy);
          if (!selected.length) continue;
          const shared = selected.filter((entry) => entry.shared).map(({ rule }) => rule.cssText);
          const legacy = selected.filter((entry) => !entry.shared).map(({ rule }) => rule.cssText);
          for (const { index } of selected.reverse()) sheet.deleteRule(index);
          for (const rule of sharedLast ? [...legacy, ...shared] : [...shared, ...legacy])
            sheet.insertRule(rule, sheet.cssRules.length);
          moved.push({ href: sheet.href, shared: shared.length, legacy: legacy.length });
        }
        return moved;
      }, sharedLast);
      assert.ok(
        reordered.some((sheet) => sheet.shared > 10 && sheet.legacy > 1),
        "CSSOM actually swaps shared and legacy/gallery rules even when Vite emits one stylesheet",
      );
      await settle();
      assert.deepEqual(
        await signature(),
        before,
        `settings computed styles survive shared styles ${sharedLast ? "after" : "before"} legacy at viewport ${width}`,
      );
      orders.push({ width, sharedLast, moved: reordered });
    }
  }
  samples.push({ settingsStylesheetOrder: orders });
  checks.push(
    "real shared and legacy/gallery CSSOM rule groups swap in both orders at wide and narrow viewports with unchanged standalone/page/dialog and Mobile computed styles; component-internal order is preserved",
  );
  await page.keyboard.press("Escape");
}

try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.AREAL_GUI_TEST_BROWSER
      ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER }
      : { channel: "chrome" }),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) => {
    if (
      route
        .request()
        .url()
        .startsWith(origin + "/")
    )
      return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.readingResize = { phase: null, samples: [], errors: [] };
    window.addEventListener("error", (event) => {
      if (window.readingResize.phase && /ResizeObserver/.test(event.message))
        window.readingResize.errors.push(event.message);
    });
    const NativeResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeResizeObserver {
      constructor(callback) {
        super((entries, observer) => {
          callback.call(observer, entries, observer);
          const capture = window.readingResize;
          if (
            !capture.phase ||
            !entries.some(
              ({ target }) =>
                target.matches(".messages, .message-column") &&
                target.closest("#activity-reading-preview"),
            )
          )
            return;
          const transcript = document.querySelector("#activity-reading-preview .messages");
          capture.samples.push({
            phase: capture.phase,
            output: transcript.querySelector('[data-side-item-id="reading-output"]')?.textContent,
            remaining: transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight,
            space: transcript.querySelector(".message-response-space").getBoundingClientRect()
              .height,
          });
        });
      }
    };
  });
  await page.goto(
    `${origin}/design-system.html${contentSystem ? "?content-system" : uiLibrary || popupAnchors ? "?ui-library" : conversationSystem ? "?conversation-system" : reuseExercise ? "?reuse-exercise" : productCandidate ? "?product-candidate" : sharedWorkspace ? "?shared-workspace" : conversationExercise ? "?conversation-exercise" : conversationDemo ? "?conversation" : decisionExercise ? "?decision-exercise" : settingsExercise ? "?settings-exercise" : settingsOnly ? "?settings" : ""}`,
  );
  await page
    .getByRole("heading", {
      name: productCandidate ? "快速开始指南" : "客户端设计系统",
      exact: true,
    })
    .waitFor();
  assert.equal(await page.evaluate(() => typeof window.arealDesktop), "undefined");
  if (namedExercise) {
    if (keyboardOnly) await runAccessibilityKeyboard(page, exercise.checks);
    else if (accessibilityOnly)
      await runAccessibility(page, scratch, gui, exercise.checks, samples);
    else if (contentSystem) await runContentSystem(page, scratch, exercise.checks);
    else if (reuseExercise) {
      const inputFiles = [
        "design-system/registry.json",
        "design-system/base.md",
        "renderer/src/design-system/base-components.ts",
      ];
      execFileSync("git", ["diff", "--exit-code", "HEAD", "--", ...inputFiles], { cwd: gui });
      exercise.inputBaseSnapshot = execFileSync(
        "git",
        ["log", "-1", "--format=%H", "--", ...inputFiles],
        { cwd: gui },
      )
        .toString()
        .trim();
      exercise.originalInputBaseSnapshot = "c98af14e00faad1b28164f660629b57c4bccea6e";
      exercise.purpose = "migration-regression";
      await runReuseExercise(page, scratch, gui, exercise);
    } else if (productCandidate) await runProductCandidate(page, scratch, exercise);
    else if (documents) await runDesignDocuments(page, origin, scratch, checks, samples);
    else if (sharedWorkspace) await runSharedWorkspace(page, scratch, exercise, baseline);
    else if (conversationExercise) await runConversationExercise(page, scratch, gui, exercise);
    else if (conversationDemo) await runConversationDemo(page, scratch, exercise.checks);
    else if (conversationSystem) await runConversationSystem(page, scratch, exercise.checks);
    else if (popupAnchors) await runPopupAnchors(page, scratch, checks);
    else if (uiLibrary) await runUiLibrary(page, scratch, exercise.checks);
    else if (decisionExercise) await runDecisionExercise(page, scratch, gui, exercise);
    else if (settingsContrast) await runSettingsContrast(page, scratch, gui, exercise);
    else await runSettingsExercise(page, scratch, gui, exercise);
    checks.push(...exercise.checks);
  } else {
    if (!settingsOnly) {
      const input = page.getByTestId("preview-composer");
      const timeline = page.getByRole("region", { name: "对话时间线预览", exact: true });
      const updating = page.getByRole("region", { name: "实时活动状态预览", exact: true });
      const reading = page.getByRole("region", { name: "活动与阅读预览", exact: true });
      const transcript = reading.locator(".messages");
      const liveTurn = reading.locator('[data-turn-id="reading-turn"]');
      const settleLayout = () =>
        page.evaluate(async () => {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          await Promise.all(
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.timeline === document.timeline &&
                  animation.playState === "running" &&
                  Number.isFinite(animation.effect?.getComputedTiming().endTime),
              )
              .map((animation) => animation.finished.catch(() => {})),
          );
          await new Promise((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
          );
        });
      const position = (control) =>
        control.evaluate((el) => {
          const container = el.closest(".messages");
          return {
            y: el.getBoundingClientRect().top - container.getBoundingClientRect().top,
            top: container.scrollTop,
            max: container.scrollHeight - container.clientHeight,
          };
        });
      const toggleHere = async (control, key, label) => {
        await control.scrollIntoViewIfNeeded();
        await settleLayout();
        const before = await position(control);
        const collapsing = await control.evaluate(
          (el) =>
            el.getAttribute("aria-expanded") === "true" ||
            el.parentElement?.matches("details[open]") === true,
        );
        if (key) {
          await control.focus();
          await control.press(key);
        } else await control.click();
        await settleLayout();
        const after = await position(control);
        const clamped = collapsing ? Math.max(0, before.top - after.max) : 0;
        assert.ok(
          Math.abs(after.y - before.y - clamped) <= 1,
          `${label} retains the activated control position: ${JSON.stringify({ before, after, clamped })}`,
        );
      };
      await transcript.scrollIntoViewIfNeeded();
      await transcript.evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await settleLayout();
      await reading.getByRole("button", { name: "接受新轮次", exact: true }).click();
      await settleLayout();
      assert.ok(
        await reading
          .locator(".message-response-space")
          .evaluate((el) => el.getBoundingClientRect().height > 0),
        "a mounted accepted follow-up reserves response space",
      );
      await page.evaluate(() => {
        window.readingResize.phase = "reserved response";
      });
      await reading.getByRole("button", { name: "延迟追加输出", exact: true }).click();
      await liveTurn
        .locator('[data-side-item-id="reading-output"]')
        .getByText("后续回复 1", { exact: false })
        .waitFor();
      await settleLayout();
      const reservedResize = await page.evaluate(() => {
        window.readingResize.phase = null;
        return window.readingResize;
      });
      samples.push({ reservedResize });
      assert.ok(
        reservedResize.samples.some((sample) => sample.output?.includes("后续回复 1")),
        "reserved response growth reaches the production ResizeObserver",
      );
      assert.deepEqual(
        reservedResize.errors,
        [],
        "response-space reconciliation does not defer undelivered ResizeObserver notifications",
      );
      await reading.getByLabel("活动形状", { exact: true }).selectOption("empty");
      await reading.getByLabel("活动形状", { exact: true }).selectOption("grouped");
      await settleLayout();
      const readingGroup = reading.locator(
        '.areal-activity-group[data-presentation="collapsible"] > .areal-disclosure > button',
      );
      assert.equal(
        await readingGroup.count(),
        1,
        "tools between two messages form one collapsible group",
      );
      await toggleHere(readingGroup, undefined, "activity group mouse expansion");
      await toggleHere(readingGroup, "Enter", "activity group keyboard collapse");
      await toggleHere(readingGroup, "Space", "activity group keyboard expansion");
      const readingCommand = reading.locator('[data-tool-id="reading-command"]');
      const commandToggle = readingCommand.locator("button.tool-summary-row");
      await toggleHere(commandToggle, undefined, "nested tool mouse expansion");
      await toggleHere(commandToggle, "Enter", "nested tool keyboard collapse");
      await toggleHere(commandToggle, "Space", "nested tool keyboard expansion");
      const fullCommand = readingCommand.locator(".command-input-toggle");
      await toggleHere(fullCommand, undefined, "full command mouse expansion");
      await toggleHere(fullCommand, "Space", "full command keyboard collapse");
      await toggleHere(fullCommand, "Enter", "full command keyboard expansion");
      const rawCommand = readingCommand.locator(".command-raw summary");
      await toggleHere(rawCommand, undefined, "native raw record mouse expansion");
      await toggleHere(rawCommand, "Enter", "native raw record keyboard collapse");
      await toggleHere(rawCommand, "Space", "native raw record keyboard expansion");
      await toggleHere(rawCommand, undefined, "native raw record mouse collapse");
      const reasoningToggle = reading.getByRole("button", { name: "思考过程", exact: true });
      await toggleHere(reasoningToggle, "Enter", "reasoning keyboard expansion");
      await toggleHere(reasoningToggle, undefined, "reasoning mouse collapse");
      const processToggle = reading.locator(".turn-progress-summary");
      await toggleHere(processToggle, "Enter", "turn progress keyboard collapse");
      await toggleHere(processToggle, undefined, "turn progress mouse expansion");
      await readingGroup.scrollIntoViewIfNeeded();
      await settleLayout();
      const beforeOutput = await position(readingGroup);
      await reading.getByRole("button", { name: "延迟追加输出", exact: true }).click();
      await liveTurn
        .locator('[data-side-item-id="reading-output"]')
        .getByText("后续回复 1", { exact: false })
        .waitFor();
      await settleLayout();
      assert.ok(
        Math.abs((await position(readingGroup)).y - beforeOutput.y) <= 1,
        "delayed tool and reply output retains reading position",
      );
      await reading.getByRole("button", { name: "滚动到底部", exact: true }).click();
      await settleLayout();
      assert.ok(
        await transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 1),
        "return to bottom reaches the transcript tail",
      );
      await page.evaluate(() => {
        window.readingResize.phase = "following tail";
        window.readingResize.samples = [];
        window.readingResize.errors = [];
      });
      await reading.getByRole("button", { name: "延迟追加输出", exact: true }).click();
      await liveTurn
        .locator('[data-side-item-id="reading-output"]')
        .getByText("后续回复 2", { exact: false })
        .waitFor();
      await settleLayout();
      const followingResize = await page.evaluate(() => {
        window.readingResize.phase = null;
        return window.readingResize;
      });
      samples.push({ followingResize });
      const appendedResize = followingResize.samples.filter((sample) =>
        sample.output?.includes("后续回复 2"),
      );
      assert.ok(appendedResize.length > 0, "tail growth reaches the production ResizeObserver");
      assert.ok(
        appendedResize.every((sample) => Math.abs(sample.remaining) <= 1),
        `following output reaches the tail during resize reconciliation before paint: ${JSON.stringify(appendedResize)}`,
      );
      assert.deepEqual(
        followingResize.errors,
        [],
        "tail reconciliation does not defer undelivered ResizeObserver notifications",
      );
      assert.ok(
        await transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 1),
        "new output follows after return to bottom",
      );
      await reading.screenshot({
        path: join(scratch, "activity-reading.png"),
        animations: "disabled",
      });
      checks.push(
        "mouse and native keyboard disclosures retain reading position across group, nested tool, full command, raw record, reasoning and turn history; delayed output respects reading and explicit bottom resumes following",
      );
      for (const [shape, expected] of [
        ["grouped", "正在运行命令…"],
        ["multiple", "正在运行命令…"],
        ["single", "正在运行命令…"],
        ["reasoning", "阅读思考过程时"],
        ["empty", "Thinking"],
      ]) {
        await reading.getByLabel("活动形状", { exact: true }).selectOption(shape);
        const status = liveTurn.getByTestId("turn-activity");
        assert.equal(await status.count(), 1, `${shape} has exactly one live turn status`);
        assert.equal(
          await liveTurn.getByTestId("turn-usage").count(),
          0,
          `${shape} has no duplicate usage status`,
        );
        assert.equal(await status.getByRole("status").count(), 1);
        assert.equal(
          await status.evaluate(
            (el) => !!el.closest("button, summary, .turn-progress, .turn-execution"),
          ),
          false,
          `${shape} status is outside every disclosure`,
        );
        assert.ok(
          (await status.innerText()).startsWith(expected),
          `${shape} status describes the whole turn`,
        );
        assert.equal(
          await status.evaluate((el) => el === el.closest("[data-turn-id]").lastElementChild),
          true,
          `${shape} status is the turn tail`,
        );
        await settleLayout();
        await status.scrollIntoViewIfNeeded();
        // IntersectionObserver publishes visibility asynchronously after layout.
        await page.waitForFunction(
          (el) => {
            const rect = el.getBoundingClientRect();
            const clip = el.closest(".messages").getBoundingClientRect();
            return (
              rect.bottom > Math.max(0, clip.top) &&
              rect.top < Math.min(innerHeight, clip.bottom) &&
              el
                .getAnimations({ subtree: true })
                .some(
                  (animation) =>
                    animation.animationName === "areal-thinking-sweep" &&
                    animation.playState === "running",
                )
            );
          },
          await status.elementHandle(),
          { timeout: 5000 },
        );
        const animations = await status.evaluate(
          (el) =>
            el
              .getAnimations({ subtree: true })
              .filter(
                (animation) =>
                  animation.animationName === "areal-thinking-sweep" &&
                  animation.playState === "running",
              ).length,
        );
        assert.equal(
          animations,
          1,
          `${shape} tail status sweeps while visible (CONV-STATUS-01: tool and model progress share one live line)`,
        );
        if (["grouped", "multiple", "single"].includes(shape))
          assert.ok(
            (await status.innerText()).includes("command line 1"),
            "current tool target stays visible in the tail status",
          );
        if (shape === "multiple") {
          assert.equal(
            await liveTurn
              .locator('.areal-activity-group[data-presentation="collapsible"]')
              .count(),
            1,
            "a command and a plan read between two messages form one group",
          );
          assert.equal(
            await liveTurn.locator('.areal-activity-group[data-presentation="inline"]').count(),
            1,
            "reasoning stays on its own",
          );
        }
        if (shape === "grouped") {
          await processToggle.click();
          assert.equal(
            await status.isVisible(),
            true,
            "folded turn history retains the separate tail status",
          );
          assert.equal(await liveTurn.getByTestId("turn-activity").count(), 1);
          await processToggle.click();
          assert.ok(
            (await readingGroup.innerText()).includes("运行命令"),
            "the execution disclosure describes its activities",
          );
          assert.match(
            await readingGroup.innerText(),
            /^已探索，已运行命令$/,
            "group titles stay past tense without counts; live progress belongs to the tail status (CONV-ACTIVITY-01)",
          );
        }
      }
      for (const [state, expected] of [
        ["input", "等待你的确认或回答"],
        ["retry", "模型连接遇到网络问题，正在重试（第 2 次）…"],
        ["disconnected", "连接已中断，任务状态待同步"],
      ]) {
        await reading.getByLabel("活动状态", { exact: true }).selectOption(state);
        const status = liveTurn.getByTestId("turn-activity");
        assert.equal(await status.innerText(), expected);
        assert.equal(
          await liveTurn.getByTestId("turn-usage").count(),
          0,
          `${state} has no conflicting usage status`,
        );
        assert.equal(
          await status.evaluate((el) => el.getAnimations({ subtree: true }).length),
          0,
          `${state} status does not animate`,
        );
      }
      await reading.getByLabel("活动状态", { exact: true }).selectOption("running");
      checks.push(
        "one sweeping tail status for tool and model progress; tool rows stay static; input, retry and disconnect retain canonical static labels",
      );
      const progressToggle = updating.locator(".turn-progress-summary");
      await progressToggle.click();
      await progressToggle.click();
      const updatingGroup = updating.locator(
        '.areal-activity-group[data-presentation="collapsible"] > .areal-disclosure > button',
      );
      assert.equal(
        await updatingGroup.count(),
        1,
        "adjacent skill reads form the disclosure whose identity is retained",
      );
      await updatingGroup.click();
      const updatingTool = updating.locator('[data-tool-id="disclosure-skill"]');
      await updatingTool.getByRole("button").click();
      await updatingTool.getByLabel("工具结果", { exact: true }).waitFor();
      for (const name of ["补全早前过程消息", "追加活动", "完成回合"]) {
        await updating.getByRole("button", { name, exact: true }).click();
        assert.equal(
          await updatingGroup.getAttribute("aria-expanded"),
          "true",
          `${name} retains the first disclosure`,
        );
        assert.equal(
          await updatingTool.getByRole("button").getAttribute("aria-expanded"),
          "true",
          `${name} retains the second disclosure`,
        );
        assert.equal(await updatingTool.getByLabel("工具结果", { exact: true }).isVisible(), true);
      }
      await updating.screenshot({
        path: join(scratch, "retained-tool-disclosures.png"),
        animations: "disabled",
      });
      checks.push(
        "both tool disclosure levels retain manual expansion when earlier commentary arrives, activities append and the turn completes",
      );
      const earlier = timeline.locator('[data-side-item-id="timeline-progress"]');
      const durationToggle = timeline.getByRole("button", {
        name: "执行过程：Worked for 19s",
        exact: true,
      });
      assert.equal(await durationToggle.getAttribute("aria-expanded"), "false");
      assert.equal(
        await earlier.isVisible(),
        false,
        "completed progress starts folded under the duration heading",
      );
      const finalOutput = timeline.locator('[data-side-item-id="timeline-final"]');
      await finalOutput.getByRole("button", { name: "预览图片 交互截图", exact: true }).waitFor();
      await finalOutput.getByRole("button", { name: "预览图片 链接图片", exact: true }).click();
      await page.getByRole("button", { name: "关闭图片预览", exact: true }).waitFor();
      assert.equal(
        await timeline
          .getByRole("status")
          .filter({ hasText: "https://example.com/linked-report" })
          .count(),
        0,
        "image preview does not open its enclosing link",
      );
      assert.equal(
        await finalOutput.locator("button button").count(),
        0,
        "image links contain independent controls",
      );
      await page.keyboard.press("Escape");
      await finalOutput.getByRole("button", { name: "验证说明", exact: true }).click();
      await timeline
        .getByRole("status")
        .filter({ hasText: "预览打开：https://example.com/report" })
        .waitFor();
      await finalOutput.getByRole("button", { name: "打开网页 对话交互预览", exact: true }).click();
      await timeline
        .getByRole("status")
        .filter({ hasText: "预览打开：http://127.0.0.1:4198/design-system.html?conversation" })
        .waitFor();
      await durationToggle.click();
      await settleLayout();
      assert.equal(await earlier.isVisible(), true);
      assert.ok(
        await durationToggle.evaluate(
          (el) =>
            !!(
              el.compareDocumentPosition(
                document.querySelector('[data-side-item-id="timeline-progress"]'),
              ) & Node.DOCUMENT_POSITION_FOLLOWING
            ),
        ),
        "duration precedes the process content after its first expansion",
      );
      const longProgress = timeline.locator('[data-side-item-id="timeline-long-progress"]');
      const progressText = longProgress.locator(".conversation-markdown");
      const progressSize = await progressText.evaluate((el) => ({
        height: el.clientHeight,
        full: el.scrollHeight,
        line: parseFloat(getComputedStyle(el).lineHeight),
        overflow: getComputedStyle(el).overflowY,
      }));
      assert.ok(
        progressSize.height > progressSize.line * 6 && progressSize.full <= progressSize.height + 1,
        "past commentary retains its full natural height",
      );
      assert.equal(progressSize.overflow, "visible");
      assert.equal(await longProgress.locator(".commentary-scroll").count(), 0);
      assert.equal(
        await longProgress.getByRole("button", { name: "展开全文", exact: true }).count(),
        0,
      );
      assert.ok((await longProgress.innerText()).includes("检查记录 10"));
      await longProgress.screenshot({
        path: join(scratch, "full-commentary.png"),
        animations: "disabled",
      });
      const fileActivity = timeline
        .locator('.areal-activity-group[data-presentation="collapsible"]')
        .filter({ has: page.locator('[data-tool-id="timeline-read"]') });
      assert.equal(
        await fileActivity.count(),
        1,
        "the fixture file-read run has one independently owned disclosure",
      );
      const activity = fileActivity.locator(".areal-activity-list");
      const activityToggle = fileActivity.locator(":scope > .areal-disclosure > button");
      assert.equal(await activityToggle.getAttribute("aria-expanded"), "false");
      assert.equal(await activity.isVisible(), false);
      await activityToggle.click();
      // 滚动时间线在展开后的渲染阶段更新，先等待其可观察状态再采样。
      await page.waitForFunction(
        (list) => getComputedStyle(list).getPropertyValue("--areal-activity-list-fade") === "24px",
        await activity.elementHandle(),
      );
      const activitySize = await activity.evaluate((el) => ({
        height: el.clientHeight,
        full: el.scrollHeight,
        overflow: getComputedStyle(el).overflowY,
        fade: getComputedStyle(el).getPropertyValue("--areal-activity-list-fade"),
      }));
      assert.equal(activitySize.overflow, "auto");
      assert.ok(activitySize.height <= 240 && activitySize.full > activitySize.height);
      assert.equal(activitySize.fade, "24px", "a list with more below fades at its bottom edge");
      await activity.press("End");
      await page.waitForFunction(
        () =>
          document
            .querySelector('#conversation-timeline [data-tool-id="timeline-read"]')
            .closest(".areal-activity-list").scrollTop > 0,
      );
      await page.waitForFunction(() => {
        const list = document
          .querySelector('#conversation-timeline [data-tool-id="timeline-read"]')
          .closest(".areal-activity-list");
        return (
          list.scrollTop + list.clientHeight >= list.scrollHeight - 1 &&
          getComputedStyle(list).getPropertyValue("--areal-activity-list-fade") === "0px"
        );
      });
      checks.push("the activity list bottom fade disappears once the list is scrolled to its end");
      assert.equal(await activity.evaluate((el) => el.clientHeight), activitySize.height);
      const imageDisclosure = timeline.getByRole("button", {
        name: "已查看 1 张图片",
        exact: true,
      });
      assert.equal(
        await imageDisclosure.getAttribute("aria-expanded"),
        "false",
        "tool images remain collapsed after expanding their activity group",
      );
      await imageDisclosure.click();
      await timeline.getByRole("button", { name: "预览图片 工具图片", exact: true }).waitFor();
      await timeline.getByRole("button", { name: "预览图片 工具图片", exact: true }).click();
      await page.getByRole("button", { name: "关闭图片预览", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await timeline.getByRole("button", { name: "预览图片 工具图片", exact: true }).waitFor();
      // CONV-PARALLEL-01: start and finish are separate events; each row opens the child and carries no extra "view" control.
      const childStarted = timeline
        .locator('[data-agent-event="started"]')
        .getByRole("button", { name: "打开 preview-child 子对话", exact: true });
      const child = timeline
        .locator('[data-agent-event="settled"]')
        .getByRole("button", { name: "打开 preview-child 子对话", exact: true });
      assert.ok(
        (await childStarted.innerText()).includes("检查消息投影") &&
          (await childStarted.innerText()).includes("开始工作"),
      );
      assert.ok((await child.innerText()).includes("检查消息投影"));
      assert.ok((await child.innerText()).includes("已完成"));
      assert.ok(!(await childStarted.innerText()).includes("查看"));
      await child.click();
      await timeline.getByRole("status").filter({ hasText: "预览打开：preview-child" }).waitFor();
      const command = timeline.locator('[data-tool-id="timeline-command"]');
      await command.getByRole("button").click();
      await command.getByLabel("工具结果", { exact: true }).waitFor();
      assert.ok(
        (await command.getByLabel("工具结果", { exact: true }).innerText()).includes(
          "类型检查通过",
        ),
      );
      const scrollOwners = await command.locator(".command-card").evaluate((el) => ({
        output: getComputedStyle(el.querySelector(".command-output")).overflowY,
        group: getComputedStyle(el.closest(".areal-activity-list")).overflowY,
      }));
      assert.equal(scrollOwners.output, "auto");
      assert.equal(
        scrollOwners.group,
        "visible",
        "an open command lifts the group list height limit while its own output scrolls",
      );
      const fileList = timeline.getByRole("region", { name: "本轮文件", exact: true });
      assert.equal(await fileList.isVisible(), true);
      assert.equal(await fileList.getByRole("button").count(), 5);
      const moreFiles = timeline.getByRole("button", { name: "展开剩余 2 个文件", exact: true });
      await moreFiles.click();
      assert.equal(await fileList.getByRole("button").count(), 7);
      await timeline.getByRole("button", { name: "收起文件", exact: true }).click();
      assert.equal(await fileList.getByRole("button").count(), 5);
      assert.equal(
        await timeline.getByLabel("合计新增 7 行，删除 7 行", { exact: true }).count(),
        1,
      );
      await timeline.getByRole("button", { name: "查看变更", exact: true }).click();
      await timeline.getByRole("status").filter({ hasText: "预览打开：本轮文件变更" }).waitFor();
      await durationToggle.click();
      await settleLayout();
      assert.equal(await earlier.isVisible(), false);
      assert.equal(await finalOutput.isVisible(), true);
      assert.equal(await fileList.isVisible(), true);
      await durationToggle.click();
      await settleLayout();
      assert.equal(
        await activityToggle.getAttribute("aria-expanded"),
        "true",
        "folding the duration retains the reader's tool expansion",
      );
      await activityToggle.click();
      assert.equal(await activity.isVisible(), false);
      await activityToggle.click();
      await timeline.getByRole("button", { name: "显示执行中", exact: true }).click();
      assert.equal(
        await timeline.getByTestId("turn-file-summary").count(),
        0,
        "running turns do not claim completed file totals",
      );
      assert.equal(
        await timeline.locator('[data-side-item-id="timeline-stream"] .collapsible-text').count(),
        0,
        "public reasoning after the current streamed reply does not fold that reply",
      );
      assert.equal(
        await timeline.locator('[data-side-item-id="timeline-stream"] .commentary-scroll').count(),
        0,
        "current streaming text is not bounded as past commentary",
      );
      assert.equal(
        await command.locator(".turn-thinking, .areal-thinking").count(),
        0,
        "a running tool row stays static; the turn tail owns the sweep (CONV-STATUS-01)",
      );
      await timeline.getByRole("button", { name: "显示已完成", exact: true }).click();
      assert.equal(
        await command.locator(".turn-thinking").count(),
        0,
        "completed activity text stops sweeping",
      );
      assert.equal(await progressText.evaluate((el) => el.clientHeight), progressSize.height);
      assert.ok(
        (await timeline.locator('[data-side-item-id="timeline-final"]').innerText()).includes(
          "最终回答保留完整内容",
        ),
      );
      checks.push(
        "commentary has full natural height; top duration folds process only; tool groups, images, links, browser cards and file changes remain usable",
      );
      await input.fill("保留这份草稿 Keep this draft");
      await input.press("Enter");
      await page.getByRole("status").filter({ hasText: "预览收到输入" }).waitFor();
      assert.equal(await input.innerText(), "保留这份草稿 Keep this draft");
      checks.push("production editor submit=false retains draft without desktop bridge");
      const composer = page.getByRole("region", { name: "Composer 预览", exact: true });
      await composer.getByTestId("composer-model-trigger").click();
      const modelDialog = page.getByRole("dialog", { name: "选择模型", exact: true });
      await modelDialog.waitFor();
      await page.keyboard.press("Escape");
      await modelDialog.waitFor({ state: "detached" });
      await page.waitForFunction(
        (element) => element === document.activeElement,
        await input.elementHandle(),
      );
      assert.equal(await input.innerText(), "保留这份草稿 Keep this draft");
      checks.push("production model menu opens/closes with draft retained");
      const longText = page.getByRole("region", { name: "长文本预览", exact: true });
      const longBubble = longText.locator('[data-side-item-id="long"]');
      const shortBubble = longText.locator('[data-side-item-id="short"]');
      const expand = longBubble.getByRole("button", { name: "展开全文", exact: true });
      // Renderer-only acceptance: exercise production Messages, layout and keyboard behavior.
      await expand.waitFor({ timeout: 5000 });
      assert.equal(await expand.getAttribute("aria-expanded"), "false");
      assert.equal(
        await shortBubble.getByRole("button", { name: "展开全文", exact: true }).count(),
        0,
      );
      const collapsedHeight = await longBubble
        .locator(".collapsible-text-viewport")
        .evaluate((el) => el.clientHeight);
      assert.ok(collapsedHeight < 240, "long sent message must leave room for the conversation");
      await expand.focus();
      await page.keyboard.press("Enter");
      const collapse = longBubble.getByRole("button", { name: "收起", exact: true });
      await collapse.waitFor();
      assert.equal(await collapse.getAttribute("aria-expanded"), "true");
      const expanded = await longBubble.locator(".collapsible-text-viewport").evaluate((el) => ({
        height: el.clientHeight,
        fullHeight: el.scrollHeight,
        overflow: getComputedStyle(el).overflowY,
        text: el.textContent,
      }));
      assert.ok(expanded.height > collapsedHeight * 2);
      assert.ok(
        expanded.fullHeight <= expanded.height + 1,
        "expanded content uses the conversation scroll",
      );
      assert.ok(expanded.text.includes("END_OF_LONG_MESSAGE"));
      exercise.steps.push({
        id: "long-text-before-space",
        ...(await collapse.evaluate((element) => ({
          focused: element === document.activeElement,
          activeElement: document.activeElement?.outerHTML.slice(0, 500),
          expanded: element.getAttribute("aria-expanded"),
          modelDialogs: document.querySelectorAll('[role="dialog"]').length,
        }))),
      });
      await page.keyboard.press("Space");
      await expand.waitFor();
      assert.equal(
        await expand.evaluate((el) => el === document.activeElement),
        true,
        "toggle retains keyboard focus",
      );
      const controlledId = await expand.getAttribute("aria-controls");
      assert.equal(
        await longBubble.locator(".collapsible-text-viewport").getAttribute("id"),
        controlledId,
      );
      // Capture the browser clipboard boundary without replacing the user's OS clipboard.
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text) => {
              window.previewCopiedText = text;
            },
          },
        });
      });
      await longBubble.getByRole("button", { name: "复制消息", exact: true }).click();
      const copied = await page.evaluate(() => window.previewCopiedText);
      assert.ok(copied.startsWith("# 长消息预览\n\n"));
      assert.ok(copied.includes("第 18 段"));
      assert.ok(
        copied.endsWith("END_OF_LONG_MESSAGE"),
        "copy includes text beyond the collapsed preview",
      );
      await longBubble.getByRole("button", { name: "末尾链接", exact: true }).focus();
      await collapse.waitFor();
      assert.equal(
        await collapse.getAttribute("aria-expanded"),
        "true",
        "keyboard focus never remains in clipped content",
      );
      await page.getByLabel("字号", { exact: true }).selectOption("18");
      assert.equal(
        await collapse.getAttribute("aria-expanded"),
        "true",
        "font reflow retains a manual expansion",
      );
      await collapse.click();
      await page.getByLabel("字号", { exact: true }).selectOption("14");
      checks.push(
        "production sent messages default to a bounded preview; short text stays open; keyboard expand/collapse retains full text and focus",
      );
      checks.push(
        "collapsed copy retains original Markdown and tail text; focusing clipped links expands; font changes preserve manual expansion",
      );
      for (const sample of [
        { theme: "light", font: "12", width: "wide" },
        { theme: "dark", font: "12", width: "wide" },
        { theme: "light", font: "14", width: "wide" },
        { theme: "dark", font: "14", width: "wide" },
        { theme: "light", font: "18", width: "narrow" },
        { theme: "dark", font: "18", width: "narrow" },
      ]) {
        await page.getByLabel("主题", { exact: true }).selectOption(sample.theme);
        await page.getByLabel("字号", { exact: true }).selectOption(sample.font);
        await page.getByLabel("面板宽度", { exact: true }).selectOption(sample.width);
        await page.waitForFunction(
          ({ font, theme }) =>
            getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size").trim() ===
              `${font}px` &&
            document.documentElement.classList.contains("dark") === (theme === "dark"),
          sample,
        );
        const measured = await page.evaluate(() => {
          const style = (selector) => {
            const el = document.querySelector(selector);
            const css = getComputedStyle(el);
            return {
              fontSize: css.fontSize,
              background: css.backgroundColor,
              color: css.color,
              radius: css.borderRadius,
              height: el.getBoundingClientRect().height,
            };
          };
          return {
            card: style(".decision-card"),
            feedback: style(".ui-feedback"),
            sideHeading: style(".side-chat-heading"),
            sideInfo: style(".side-chat-information"),
            composer: style(".composer-editor [contenteditable]"),
            response: style(".assistant-message"),
            userMessage: style(".user-bubble"),
            overflow: [...document.querySelectorAll(".design-preview-panel")].some(
              (el) => el.scrollWidth > el.clientWidth + 1,
            ),
          };
        });
        assert.equal(measured.overflow, false, "preview panels must not overflow horizontally");
        assert.equal(measured.card.fontSize, `${sample.font}px`);
        assert.equal(measured.card.radius, "20px");
        assert.equal(measured.feedback.fontSize, `${sample.font}px`);
        if (!baseline) {
          assert.equal(measured.sideHeading.fontSize, `${Math.max(12, Number(sample.font) - 2)}px`);
          assert.equal(measured.sideInfo.fontSize, `${Math.max(11, Number(sample.font) - 3)}px`);
        }
        assert.equal(
          measured.composer.fontSize,
          "14px",
          "composer content font stays independent of the interface font fixture",
        );
        assert.equal(measured.response.fontSize, "14px");
        assert.equal(measured.userMessage.fontSize, "14px");
        assert.equal(
          await expand.getAttribute("aria-expanded"),
          "false",
          "theme/font/width changes retain collapsed state",
        );
        const previewSize = await longBubble
          .locator(".collapsible-text-viewport")
          .evaluate((el) => ({
            height: el.clientHeight,
            line: parseFloat(getComputedStyle(el).lineHeight),
            width: el.clientWidth,
            fullWidth: el.scrollWidth,
          }));
        assert.ok(
          Math.abs(previewSize.height - previewSize.line * 8) <= 1,
          "preview follows eight rendered lines at the current font size",
        );
        assert.ok(
          previewSize.fullWidth <= previewSize.width + 1,
          "long text wraps inside the bubble",
        );
        const wrappedText = longText.locator('[data-side-item-id="wrapped"]');
        await page.waitForFunction(
          ({ narrow }) => {
            const button = document.querySelector(
              '[data-side-item-id="wrapped"] .collapsible-text-toggle',
            );
            return Boolean(button) === narrow;
          },
          { narrow: sample.width === "narrow" },
        );
        assert.equal(
          await wrappedText.getByRole("button", { name: "展开全文", exact: true }).count(),
          sample.width === "narrow" ? 1 : 0,
          "unbroken paragraphs fold only when the rendered width requires it",
        );
        await input.fill("第一行 First line");
        await input.press("Shift+Enter");
        const caret = await input.evaluate((element) => {
          const style = getComputedStyle(element),
            paragraph = getComputedStyle(element.firstElementChild);
          return {
            color: style.color,
            caret: style.caretColor,
            font: style.fontSize,
            paragraphFont: paragraph.fontSize,
            line: style.lineHeight,
            paragraphLine: paragraph.lineHeight,
            text: element.innerText,
          };
        });
        assert.equal(caret.caret, caret.color, "caret follows light/dark foreground after newline");
        assert.equal(caret.paragraphFont, caret.font, "empty line retains editor typography");
        assert.equal(caret.paragraphLine, caret.line);
        assert.ok(
          parseFloat(caret.line) <= parseFloat(caret.font) + 8,
          "caret line does not stretch to editor height",
        );
        await input.fill("保留这份草稿 Keep this draft");
        samples.push({ ...sample, measured });
        await page.locator(".design-preview").evaluate((element) => element.scrollTo(0, 0));
        await page.screenshot({
          path: join(scratch, `${sample.theme}-${sample.font}-${sample.width}.png`),
          fullPage: true,
          animations: "disabled",
        });
        for (const name of ["Composer 预览", "审批预览", "Side 预览"]) {
          await page.getByRole("region", { name, exact: true }).screenshot({
            path: join(scratch, `${sample.theme}-${sample.font}-${sample.width}-${name}.png`),
            animations: "disabled",
          });
        }
        await longText.locator(".messages").evaluate((el) => el.scrollTo(0, 0));
        await longText.screenshot({
          path: join(scratch, `${sample.theme}-${sample.font}-${sample.width}-long-text.png`),
          animations: "disabled",
        });
      }
      checks.push(
        "light/dark and wide/narrow production components; semantic typography and layout",
      );
      checks.push("newline caret follows theme and editor typography at both font sizes");
      const motion = page.getByRole("region", { name: "聊天动效预览", exact: true });
      const stream = page.getByTestId("preview-stream");
      const waiting = motion.locator(".areal-thinking-sweep");
      await page.getByRole("checkbox", { name: "减少动态效果", exact: true }).uncheck();
      for (const theme of ["light", "dark"]) {
        await page.getByLabel("主题", { exact: true }).selectOption(theme);
        await page.waitForFunction(
          () => document.documentElement.dataset.reducedMotion === "false",
        );
        await motion.getByRole("button", { name: "追加片段", exact: true }).click();
        const priorText = await stream.innerText();
        assert.ok(
          priorText.startsWith("流式文字沿用当前"),
          "the first streamed fragment is immediately readable",
        );
        await motion.getByRole("button", { name: "追加片段", exact: true }).click();
        const streamedText = await stream.innerText();
        assert.ok(
          streamedText.startsWith(priorText) && streamedText.length > priorText.length,
          "append immediately displays new text and retains earlier Chinese text",
        );
        const appearance = await stream.locator(".conversation-markdown").evaluate((element) => ({
          opacity: getComputedStyle(element).opacity,
          animations: element.getAnimations({ subtree: true }).length,
          characterWrappers: element.querySelectorAll("[data-sd-animate]").length,
        }));
        assert.deepEqual(
          appearance,
          { opacity: "1", animations: 0, characterWrappers: 0 },
          "streamed Markdown remains visible without per-character animation wrappers",
        );
        await waiting.scrollIntoViewIfNeeded();
        await page.waitForFunction(
          () =>
            document
              .querySelector('[aria-label="聊天动效预览"] .areal-thinking-sweep')
              ?.getAnimations().length > 0,
        );
        const animations = await waiting.evaluate((element) => {
          // app/node_modules/playwright-core/lib/server/screenshotter.js replays canceled infinite effects; sample a fresh stylesheet animation.
          const inlineAnimation = element.style.animation;
          element.getAnimations().forEach((animation) => animation.cancel());
          element.style.animation = "none";
          void getComputedStyle(element).animationName;
          element.style.animation = inlineAnimation;
          void getComputedStyle(element).animationName;
          return element.getAnimations().map((animation) => ({
            name: animation.animationName,
            duration: Number(animation.effect.getTiming().duration),
          }));
        });
        assert.deepEqual(
          animations,
          [{ name: "areal-thinking-sweep", duration: 1800 }],
          "phase sampling controls one fresh stylesheet sweep after screenshot replay cleanup",
        );
        await waiting.evaluate((element) => {
          const animation = element.getAnimations()[0];
          animation.pause();
        });
        const sweep = [],
          frames = [];
        for (const fraction of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999999, 1]) {
          await waiting.evaluate((element, time) => {
            element.getAnimations()[0].currentTime = time;
          }, animations[0].duration * fraction);
          const frame = await waiting.screenshot({
            animations: "allow",
            path: join(scratch, `${theme}-sweep-${fraction}.png`),
          });
          frames.push(frame.toString("base64"));
          sweep.push({
            fraction,
            position: await waiting.evaluate((el) => parseFloat(getComputedStyle(el).maskPosition)),
            sha256: createHash("sha256").update(frame).digest("hex"),
          });
        }
        await writeFile(join(scratch, `${theme}-sweep.json`), JSON.stringify(sweep, null, 2));
        for (let index = 1; index < 6; index++)
          assert.notEqual(
            sweep[index].sha256,
            sweep[index - 1].sha256,
            "waiting highlight remains visibly moving throughout the cycle",
          );
        assert.ok(
          sweep[0].position > sweep[2].position && sweep[2].position > sweep[3].position,
          "the oversized highlight background moves from a negative offset toward zero, sweeping left to right",
        );
        // 背景定位的小数舍入可影响抗锯齿，逐字节哈希不能稳定比较两帧；按平均像素差判断。
        const frameDifference = (first, last) =>
          page.evaluate(
            async ({ first, last }) => {
              const pixels = async (source) => {
                const image = new Image();
                image.src = `data:image/png;base64,${source}`;
                await image.decode();
                const canvas = document.createElement("canvas");
                canvas.width = image.width;
                canvas.height = image.height;
                const context = canvas.getContext("2d");
                context.drawImage(image, 0, 0);
                return context.getImageData(0, 0, image.width, image.height).data;
              };
              const a = await pixels(first),
                b = await pixels(last);
              return (
                a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length
              );
            },
            { first, last },
          );
        // 允许每通道不足一个色阶的平均差异。
        const seamDifference = await frameDifference(frames[0], frames[6]);
        assert.ok(seamDifference < 1, `waiting sweep has no visible seam: ${seamDifference}`);
        const phaseDifference = await frameDifference(frames[0], frames[7]);
        assert.ok(
          phaseDifference < 1,
          `waiting highlight repeats at the same phase: ${phaseDifference}`,
        );
        await motion.screenshot({
          path: join(scratch, `${theme}-chat-motion.png`),
          animations: "allow",
        });
        await waiting.evaluate((element) => element.getAnimations()[0].play());
        samples.push({ theme, streamedText, appearance, sweep, seamDifference });
      }
      checks.push(
        "Chinese streaming append is immediately readable, preserves earlier text without character wrappers, and retains the themed waiting sweep",
      );
      await motion.getByRole("button", { name: "完成输出", exact: true }).click();
      assert.equal(
        await stream.locator("[data-sd-animate]").count(),
        0,
        "completed Markdown has no streaming animation wrappers",
      );
      assert.ok((await stream.innerText()).includes("Streaming text stays readable"));
      assert.equal(await stream.locator("li").count(), 2);
      assert.equal(await stream.locator("strong").innerText(), "加粗");
      await page.getByRole("checkbox", { name: "减少动态效果", exact: true }).check();
      await page.waitForFunction(() => document.documentElement.dataset.reducedMotion === "true");
      assert.equal(await waiting.evaluate((element) => element.getAnimations().length), 0);
      await motion.getByRole("button", { name: "播放流式输出", exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="preview-stream"]').textContent.includes("流式文字"),
      );
      assert.equal(
        await stream.locator("[data-sd-animate]").count(),
        0,
        "reduced motion shows streamed content immediately",
      );
      checks.push(
        "completed Markdown retains formatting; reduced motion keeps streamed text readable and disables the waiting sweep",
      );
      await page.getByLabel("状态", { exact: true }).selectOption("busy");
      assert.equal(await input.getAttribute("contenteditable"), "false");
      await page
        .getByRole("region", { name: "工具审批", exact: true })
        .getByRole("button", { name: "允许一次", exact: true })
        .click();
      await page.getByText("提交中…", { exact: true }).waitFor();
      await page.getByLabel("状态", { exact: true }).selectOption("failed");
      const card = page.getByRole("region", { name: "工具审批", exact: true });
      await card.getByRole("button", { name: "允许一次", exact: true }).click();
      await card.getByRole("alert").waitFor();
      await page.getByLabel("状态", { exact: true }).selectOption("unknown");
      await card.getByRole("button", { name: "允许一次", exact: true }).click();
      await card.getByRole("button", { name: "核对待审批状态", exact: true }).waitFor();
      assert.equal(await card.getByRole("button", { name: "允许一次", exact: true }).count(), 0);
      checks.push(
        "real approval component shows busy/failure/unknown and blocks duplicate decisions",
      );
    }
    await settingsChecks();
  }
  if (!namedExercise) await runAccessibility(page, scratch, gui, checks, samples);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  passed = true;
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page)
    await page.screenshot({ path: join(scratch, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        baseline,
        settingsOnly,
        documents,
        productCandidate,
        exercise,
        commit,
        buildSha256,
        checks,
        errors,
        external,
        samples,
        scope:
          "production renderer components with local fixture actions; no Electron/Core acceptance",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, scratch, checks, errors }));
}
