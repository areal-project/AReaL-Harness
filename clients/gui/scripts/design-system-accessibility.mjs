import { runAccessibilityKeyboard } from "./design-system-keyboard.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectThemeEvidence, verifyThemeEvidence } from "./theme-evidence.mjs";

export function contrastRatio(foreground, background) {
  const luminance = (rgb) =>
    rgb
      .slice(0, 3)
      .map((channel) => channel / 255)
      .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function summarizeAxe(result) {
  const violations = result.violations.map((rule) => ({
    id: rule.id,
    impact: rule.impact,
    help: rule.help,
    helpUrl: rule.helpUrl,
    targets: rule.nodes.map((node) => node.target),
    nodes: rule.nodes.map((node) => ({
      target: node.target,
      html: node.html,
      failureSummary: node.failureSummary,
    })),
  }));
  return {
    violations,
    blocking: violations.filter((rule) => ["critical", "serious"].includes(rule.impact)),
    moderate: violations
      .filter((rule) => rule.impact === "moderate")
      .reduce((sum, rule) => sum + rule.targets.length, 0),
    incomplete: result.incomplete.map((rule) => ({
      id: rule.id,
      targets: rule.nodes.map((node) => node.target),
    })),
  };
}

export function assertAccessibleReport(report, moderateBaseline = 0) {
  assert.ok(report.scans.length > 0, "axe must execute on mounted previews");
  assert.equal(
    report.scans.flatMap((scan) => scan.blocking).length,
    0,
    "serious or critical accessibility violations",
  );
  assert.equal(report.contrast.defaultFailures, 0, "default theme contrast failures");
  assert.equal(
    report.scans.reduce((sum, scan) => sum + scan.moderate, 0),
    moderateBaseline,
    "moderate accessibility issues exceed the zero baseline",
  );
}

export async function runThemeContrast(browser, scratch) {
  const evidence = await collectThemeEvidence(browser);
  const pairs = [
    {
      id: "body",
      foreground: "--color-foreground",
      background: "--color-background",
      minimum: 4.5,
      use: "Default reading text",
    },
    {
      id: "settings-label",
      foreground: "--color-foreground",
      background: "--color-settings-card",
      minimum: 4.5,
      use: "Settings row labels",
    },
    {
      id: "settings-description",
      foreground: "--color-settings-secondary",
      background: "--color-settings-card",
      minimum: 4.5,
      use: "Active settings explanations",
    },
    {
      id: "secondary-text",
      foreground: "--color-foreground-subtle",
      background: "--color-background",
      minimum: 4.5,
      use: "Secondary text on reading surface",
    },
    {
      id: "subtlest-metadata",
      foreground: "--color-foreground-subtlest",
      background: "--color-background",
      minimum: 4.5,
      use: "Small process metadata, report existing debt",
    },
    {
      id: "settled-metadata",
      foreground: "--color-process-settled",
      background: "--color-background",
      minimum: 4.5,
      use: "Completed process metadata",
    },
    {
      id: "user-message",
      foreground: "--color-user-message-text",
      background: "--color-user-message",
      minimum: 4.5,
      use: "Sent message text",
    },
    {
      id: "primary-action",
      foreground: "--color-primary-foreground",
      background: "--color-primary",
      minimum: 4.5,
      use: "Primary and composer send controls",
    },
    {
      id: "warning-action",
      foreground: "--color-warning-foreground",
      background: "--color-warning",
      minimum: 4.5,
      use: "Warning variant button text",
    },
    {
      id: "destructive-action",
      foreground: "--color-destructive-foreground",
      background: "--color-destructive",
      minimum: 4.5,
      use: "Destructive variant button text",
    },
    {
      id: "file-reference",
      foreground: "--color-file-reference",
      background: "--color-background",
      minimum: 4.5,
      use: "Inline file reference text",
    },
    {
      id: "menu-text",
      foreground: "--color-foreground",
      background: "--color-menu",
      minimum: 4.5,
      use: "Menu text over translucent menu and reading backdrop",
    },
    {
      id: "composer-text",
      foreground: "--color-foreground",
      background: "--color-composer",
      minimum: 4.5,
      use: "Composer text over translucent surface and reading backdrop",
    },
    {
      id: "navigation-text",
      foreground: "--color-foreground",
      background: "--color-navigation-background",
      minimum: 4.5,
      use: "Navigation text over sidebar material and reading backdrop",
    },
    {
      id: "focus-ring",
      foreground: "--color-input-border-focused",
      background: "--color-input",
      minimum: 3,
      use: "Focus indicator against input surface",
    },
  ];
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(
    `<style>${await readFile(new URL("../packages/ui/src/generated/foundation.css", import.meta.url), "utf8")}</style>`,
  );
  const rows = [];
  for (const sample of evidence.samples) {
    const observed = await page.evaluate(
      ({ colors, pairs, dark }) => {
        document.documentElement.classList.toggle("dark", dark);
        Object.entries(colors).forEach(([name, value]) =>
          document.documentElement.style.setProperty(name, value.color),
        );
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        const probe = document.createElement("span");
        document.body.append(probe);
        const observations = pairs.map((pair) => {
          probe.style.color = `var(${pair.foreground})`;
          probe.style.backgroundColor = `var(${pair.background})`;
          const css = getComputedStyle(probe);
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = colors["--color-background"].color;
          context.fillRect(0, 0, 1, 1);
          context.fillStyle = css.backgroundColor;
          context.fillRect(0, 0, 1, 1);
          const background = [...context.getImageData(0, 0, 1, 1).data];
          context.fillStyle = css.color;
          context.fillRect(0, 0, 1, 1);
          return {
            ...pair,
            color: css.color,
            surface: css.backgroundColor,
            backdrop: colors["--color-background"].color,
            background,
            foregroundPixel: [...context.getImageData(0, 0, 1, 1).data],
          };
        });
        probe.remove();
        return observations;
      },
      { colors: sample.colors, pairs, dark: sample.input.dark },
    );
    rows.push(
      ...observed.map((pair) => ({
        input: sample.input,
        ...pair,
        ratio: contrastRatio(pair.foregroundPixel, pair.background),
        passed: contrastRatio(pair.foregroundPixel, pair.background) >= pair.minimum,
      })),
    );
  }
  await context.close();
  const report = {
    mode: "blocking-defaults",
    scope:
      "Explicit production role pairs resolved by Chrome. Browser canvas composites alpha over the listed solid palette backdrop. This does not measure native blur over nonuniform content, every placement or antialiased text edges.",
    browser: evidence.browser,
    pairs,
    rows,
    failures: rows.filter((row) => !row.passed),
    defaultFailures: rows.filter((row) => row.input.id.startsWith("default-") && !row.passed),
    gaps: [
      "Custom palette text/background contrast is reported in settings; colors remain user controlled.",
      "VoiceOver reading order and announcements not verified.",
    ],
  };
  await writeFile(join(scratch, "contrast-matrix.json"), JSON.stringify(report, null, 2) + "\n");
  return {
    samples: evidence.samples.length,
    pairs: pairs.length,
    failures: report.failures.length,
    defaultFailures: report.defaultFailures.length,
  };
}

export async function runAccessibility(page, scratch, gui, checks, samples) {
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const browser = page.context().browser();
  const palette = await verifyThemeEvidence(browser, scratch);
  const contrast = await runThemeContrast(browser, scratch);
  const scans = [];
  const origin = new URL(page.url()).origin;
  for (const route of ["", "?settings", "?ui-library"]) {
    for (const theme of ["light", "dark"]) {
      const scenario = await page.context().newPage();
      try {
        await scenario.goto(`${origin}/design-system.html${route}`);
        await scenario.getByRole("heading", { name: "客户端设计系统", exact: true }).waitFor();
        await scenario.getByLabel("主题", { exact: true }).selectOption(theme);
        await scenario.waitForFunction(
          (dark) => document.documentElement.classList.contains("dark") === dark,
          theme === "dark",
        );
        const states = route ? ["ready"] : ["ready", "busy", "failed", "unknown"];
        for (const state of states) {
          if (!route) await scenario.getByLabel("状态", { exact: true }).selectOption(state);
          // 扫描所选主题的稳定状态，避免把继承文字与尚在过渡的旧背景混合取样。
          await scenario.waitForFunction(() =>
            document
              .getAnimations()
              .every(
                (animation) =>
                  !(animation instanceof CSSTransition) || animation.playState === "finished",
              ),
          );
          const result = await new AxeBuilder({ page: scenario })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
          const components = await scenario.evaluate(
            (violations) =>
              Object.fromEntries(
                violations.flatMap((rule) =>
                  rule.nodes.map((node) => {
                    const target = node.target;
                    let documentRoot = document;
                    let element = null;
                    for (const selector of target) {
                      if (typeof selector !== "string")
                        return [JSON.stringify(target), "unresolved shadow target"];
                      element = documentRoot.querySelector(selector);
                      if (element?.tagName === "IFRAME") documentRoot = element.contentDocument;
                    }
                    const owner =
                      element?.closest("[data-component], article[id], .design-preview-panel") ??
                      element?.parentElement?.closest("[aria-label], .library-example");
                    return [
                      JSON.stringify(target),
                      owner?.getAttribute("data-component") ??
                        owner?.getAttribute("aria-label") ??
                        owner?.className ??
                        "preview document",
                    ];
                  }),
                ),
              ),
            result.violations,
          );
          scans.push({ route, theme, state, components, ...summarizeAxe(result) });
          await writeFile(
            join(scratch, "accessibility.json"),
            JSON.stringify(
              {
                mode: "blocking-defaults",
                axeVersion: result.testEngine.version,
                scans,
                palette,
                contrast,
                gaps: [
                  "Only mounted preview states are scanned. Unopened menu/dialog states and real Core journeys are not exhaustive.",
                  "Keyboard and reduced-motion checks remain in their existing design and desktop smoke owners.",
                  "VoiceOver has not been run.",
                ],
              },
              null,
              2,
            ) + "\n",
          );
        }
      } finally {
        await scenario.close();
      }
    }
  }
  samples.push({
    accessibility: {
      scans: scans.length,
      seriousOrCritical: scans.reduce(
        (sum, scan) => sum + scan.blocking.reduce((count, rule) => count + rule.targets.length, 0),
        0,
      ),
      contrast,
      palette,
      report: "accessibility.json",
    },
  });
  checks.push(
    `palette snapshot: ${palette.samples} samples × ${palette.legacyVariables} legacy roles checked against the frozen baseline and explicit accessibility revision; ${palette.addedVariables} new roles recorded`,
  );
  checks.push(
    `accessibility gate: ${scans.length} axe scans and default-theme contrast matrix; custom themes remain diagnostic`,
  );
  const accessibilityBaseline = JSON.parse(
    await readFile(join(gui, "design-system/accessibility-baseline.json"), "utf8"),
  );
  assert.equal(
    accessibilityBaseline.contrastExceptions.length,
    0,
    "default contrast exceptions require an explicit gate implementation",
  );
  assertAccessibleReport({ scans, contrast }, accessibilityBaseline.moderateIssues);
  await runAccessibilityKeyboard(page, checks);
  const metadata = JSON.parse(await readFile(join(gui, "packages/ui/tokens.json"), "utf8"));
  assert.equal(
    Object.keys(metadata.palette.roles).filter((name) => name.startsWith("--color-")).length,
    palette.variables,
    "all palette color roles need metadata",
  );
}
