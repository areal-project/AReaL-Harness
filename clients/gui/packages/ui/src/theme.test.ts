import { expect, test } from "vite-plus/test";
import { paletteVariables, readableForeground, colorContrastRatio } from "./theme.js";

// R-DECISION-023：这些文字角色在任何主题、任何对比度偏好下都不低于 4.5:1。
const TEXT_ROLES = [
  "--color-foreground-subtle",
  "--color-foreground-subtlest",
  "--color-activity-summary",
  "--color-activity-child",
  "--color-settings-secondary",
  "--color-status-settled",
];
function textContrast(value: string, background: string) {
  const [, foreground, percent, into] = value.match(
    /^color-mix\(in \w+, (#[\da-f]{6}) ([\d.]+)%, (#[\da-f]{6}|transparent)\)$/,
  )!;
  const base = into === "transparent" ? background : into;
  const mixed = [0, 1, 2]
    .map((index) => {
      const channel = (color: string) => parseInt(color.slice(1 + index * 2, 3 + index * 2), 16);
      return Math.round(
        (channel(foreground) * Number(percent) + channel(base) * (100 - Number(percent))) / 100,
      )
        .toString(16)
        .padStart(2, "0");
    })
    .join("");
  return colorContrastRatio(`#${mixed}`, background);
}

test("primary controls choose a readable foreground at both luminance extremes", () => {
  expect(readableForeground("#ffffff")).toBe("#000000");
  expect(readableForeground("#000000")).toBe("#ffffff");
  expect(readableForeground("#808080")).toBe("#000000");
});

test("default and custom palettes retain input roles and component aliases", () => {
  for (const dark of [false, true]) {
    for (const contrast of [0, 45, 100]) {
      const palette = {
        background: dark ? "#181818" : "#ffffff",
        foreground: dark ? "#ffffff" : "#111111",
        accent: "#3a83f7",
        contrast,
        translucentSidebar: true,
      };
      const variables = paletteVariables(palette, dark);
      expect(variables["--color-background"]).toBe(palette.background);
      expect(variables["--color-foreground"]).toBe(palette.foreground);
      expect(variables["--color-brand"]).toBe(palette.accent);
      expect(variables["--color-composer-action"]).toBe("var(--color-primary)");
      expect(variables["--color-input-border"]).toBe("var(--color-border)");
      expect(variables["--color-user-message"]).toBe(dark ? "#173e76" : "#e8f3fe");
      for (const role of TEXT_ROLES)
        expect(textContrast(variables[role], palette.background)).toBeGreaterThanOrEqual(4.5);
    }
  }
  const custom = paletteVariables(
    {
      background: "#223344",
      foreground: "#eeffff",
      accent: "#88bbff",
      contrast: 60,
      translucentSidebar: false,
    },
    true,
  );
  expect(custom["--color-user-message-text"]).toBe("#eeffff");
  expect(custom["--color-file-reference"]).toBe("color-mix(in srgb, #88bbff 80%, #eeffff)");
});

test("reference overrides match only their original inputs", () => {
  const customDark = {
    background: "#182838",
    foreground: "#eeeeee",
    accent: "#3a83f7",
    contrast: 60,
    translucentSidebar: false,
  };
  expect(paletteVariables(customDark, true)["--color-file-reference"]).toBe(
    "color-mix(in srgb, #2c67c5 80%, #eeeeee)",
  );
  expect(paletteVariables(customDark, true)["--color-user-message"]).toBe(
    "color-mix(in srgb, #eeeeee 6%, #182838)",
  );
  expect(paletteVariables(customDark, true)["--color-user-message-text"]).toBe("#eeeeee");
  expect(paletteVariables({ ...customDark, background: "#181818" }, true)["--color-sidebar"]).toBe(
    "rgb(40 40 40 / 1)",
  );
  expect(
    paletteVariables({ ...customDark, background: "#181818", translucentSidebar: true }, true)[
      "--color-sidebar"
    ],
  ).toBe("rgb(40 40 40 / 0.7)");
  expect(
    paletteVariables({ ...customDark, foreground: "#ffffff" }, true)["--color-primary-foreground"],
  ).toBe("#2d2d2d");
  expect(
    paletteVariables({ ...customDark, foreground: "#ffffff" }, false)["--color-primary-foreground"],
  ).toBe("#000000");
});

test("contrast and material derivations retain their captured precision", () => {
  const palette = {
    background: "#181818",
    foreground: "#ffffff",
    accent: "#3a83f7",
    contrast: 60,
    translucentSidebar: true,
  };
  const dark = paletteVariables(palette, true);
  expect(dark["--color-result-card"]).toBe(
    "color-mix(in srgb, color-mix(in srgb, #ffffff 9.090909090909092%, #181818) 50%, transparent)",
  );
  expect(dark["--color-composer"]).toBe(
    "color-mix(in srgb, color-mix(in srgb, #ffffff 12.987012987012987%, #181818) 96%, transparent)",
  );
  expect(dark["--color-process-settled"]).toBe("color-mix(in srgb, #ffffff 55%, transparent)");
  expect(dark["--color-settings-secondary"]).toBe("color-mix(in srgb, #ffffff 65%, transparent)");
  expect(dark["--shadow-result-card"]).toBe(
    "0 0 0 .5px color-mix(in srgb, #ffffff 15.6%, transparent)",
  );
  const light = paletteVariables(
    { ...palette, background: "#ffffff", foreground: "#1a1c1f", contrast: 45 },
    false,
  );
  expect(light["--color-composer"]).toBe("color-mix(in srgb, #ffffff 86.4706%, transparent)");
  expect(light["--color-navigation-background"]).toBe(
    "color-mix(in oklab, #ffffff 70%, transparent)",
  );
  expect(light["--color-process-settled"]).toBe("color-mix(in srgb, #1a1c1f 75%, #ffffff)");
  expect(paletteVariables({ ...palette, contrast: 0 }, true)["--color-border"]).toBe(
    "color-mix(in srgb, #ffffff 3.6000000000000005%, transparent)",
  );
});

test("custom color diagnostics measure the chosen text against its background", () => {
  expect(colorContrastRatio("#000000", "#ffffff")).toBe(21);
  expect(colorContrastRatio("#ffffff", "#ffffff")).toBe(1);
  expect(colorContrastRatio("#787878", "#ffffff")).toBeLessThan(4.5);
  expect(colorContrastRatio("#1a1c1f", "#ffffff")).toBeGreaterThan(4.5);
});
