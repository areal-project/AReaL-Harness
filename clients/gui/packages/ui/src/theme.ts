import { derivePaletteVariables, PALETTE_REFERENCES } from "./generated/palette.js";

export type Palette = {
  background: string;
  foreground: string;
  accent: string;
  contrast: number;
  translucentSidebar: boolean;
};

export function readableForeground(
  background: string,
): typeof PALETTE_REFERENCES.black | typeof PALETTE_REFERENCES.white {
  const luminance = relativeLuminance(background);
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05)
    ? PALETTE_REFERENCES.black
    : PALETTE_REFERENCES.white;
}

export function colorContrastRatio(foreground: string, background: string) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function relativeLuminance(background: string) {
  const rgb = background
    .slice(1)
    .match(/../g)!
    .map((n) => parseInt(n, 16));
  // 十六进制解码、WCAG 亮度和对比度使用算法常量；黑白候选值归 tokens.json。
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function paletteVariables(p: Palette, dark = false): Record<string, string> {
  return derivePaletteVariables(p, dark, readableForeground, minimumPercent);
}

/** 前景按 percent 混入背景后，对比度不足 contrast 时把百分比推高到达标（半个百分点为一步）。 */
export function minimumPercent(
  foreground: string,
  background: string,
  percent: number,
  contrast: number,
) {
  let value = percent;
  while (
    value < 100 &&
    colorContrastRatio(mixHex(foreground, background, value), background) < contrast
  )
    value = Math.min(100, Math.floor(value * 2 + 1) / 2);
  return value;
}

function mixHex(foreground: string, background: string, percent: number) {
  const channels = (color: string) =>
    color
      .slice(1)
      .match(/../g)!
      .map((n) => parseInt(n, 16));
  const [a, b] = [channels(foreground), channels(background)];
  return `#${a
    .map((channel, index) =>
      Math.round((channel * percent + b[index] * (100 - percent)) / 100)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * 切换主题时暂停全部过渡：否则背景瞬间变色，而带颜色过渡的控件慢半拍跟上。
 * 先应用主题并强制一次样式计算，再在下一帧恢复过渡。
 */
export function applyThemeWithoutTransitions(root: HTMLElement, apply: () => void) {
  root.setAttribute("data-theme-switching", "");
  apply();
  void getComputedStyle(root).color;
  requestAnimationFrame(() => root.removeAttribute("data-theme-switching"));
}
