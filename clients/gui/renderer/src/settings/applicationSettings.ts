import { DEFAULT_THEME_INPUTS } from "@areal/ui/theme-defaults";
export { readableForeground, paletteVariables } from "@areal/ui/theme";
import type { AppLocale } from "../i18n/messages.js";
import type { PermissionPreset } from "../permissions.js";
export const UI_FONTS = {
  system:
    '-apple-system, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", sans-serif',
  Arial: 'Arial, "PingFang SC", sans-serif',
  Georgia: 'Georgia, "Songti SC", serif',
  PingFang: '"PingFang SC", sans-serif',
};
export const CODE_FONTS = {
  system:
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "PingFang SC", monospace',
  Menlo: "Menlo, Consolas, monospace",
  Courier: '"Courier New", monospace',
};
export type ThemeFonts = {
  uiFont: keyof typeof UI_FONTS;
  contentFont: keyof typeof UI_FONTS | "inherit";
  codeFont: keyof typeof CODE_FONTS;
};
const DEFAULT_FONTS: ThemeFonts = { uiFont: "system", contentFont: "inherit", codeFont: "system" };
export type Palette = {
  fonts: ThemeFonts;
  background: string;
  foreground: string;
  accent: string;
  contrast: number;
  translucentSidebar: boolean;
};
export const DEFAULT_PALETTES: Record<"light" | "dark", Palette> = {
  light: {
    fonts: DEFAULT_FONTS,
    ...DEFAULT_THEME_INPUTS.light,
    translucentSidebar: true,
  },
  dark: {
    fonts: DEFAULT_FONTS,
    ...DEFAULT_THEME_INPUTS.dark,
    translucentSidebar: true,
  },
};
export type ApplicationSettings = {
  locale: AppLocale;
  contentSize: number;
  pointerCursor: boolean;
  fontSmoothing: boolean;
  reducedMotion: "system" | "on" | "off";
  diffMarkers: "color" | "signs";
  nextPromptSuggestions: boolean;
  sendShortcut: "enter" | "modifier";
  followUp: "queue" | "steer";
  defaultPermissionPreset: PermissionPreset;
  terminalLocation: "bottom" | "right";
  showBottomPanelControl: boolean;
  light: Palette;
  dark: Palette;
};
export const DEFAULT_APPLICATION_SETTINGS: ApplicationSettings = {
  locale: "zh-CN",
  contentSize: 14,
  pointerCursor: false,
  fontSmoothing: true,
  reducedMotion: "system",
  diffMarkers: "color",
  nextPromptSuggestions: true,
  sendShortcut: "enter",
  followUp: "queue",
  defaultPermissionPreset: "autoReview",
  terminalLocation: "right",
  showBottomPanelControl: true,
  ...DEFAULT_PALETTES,
};
export const validColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
export function normalizeApplicationSettings(raw: any): ApplicationSettings {
  const saved = raw && typeof raw === "object" ? raw : {};
  const result = { ...DEFAULT_APPLICATION_SETTINGS };
  result.locale = saved.locale === "en" ? "en" : "zh-CN";
  result.contentSize =
    Number.isFinite(saved.contentSize) &&
    saved.contentSize >= 12 &&
    saved.contentSize <= 24
      ? saved.contentSize
      : 14;
  result.nextPromptSuggestions = saved.nextPromptSuggestions !== false;
  result.sendShortcut =
    saved.sendShortcut === "modifier" ? "modifier" : "enter";
  result.pointerCursor = saved.pointerCursor === true;
  result.fontSmoothing = saved.fontSmoothing !== false;
  result.reducedMotion = saved.reducedMotion === "on" || saved.reducedMotion === "off" ? saved.reducedMotion : "system";
  result.diffMarkers = saved.diffMarkers === "signs" ? "signs" : "color";
  result.followUp = saved.followUp === "steer" ? "steer" : "queue";
  result.defaultPermissionPreset = saved.defaultPermissionPreset === "ask" || saved.defaultPermissionPreset === "autoReview" || saved.defaultPermissionPreset === "fullAccess"
    ? saved.defaultPermissionPreset : "autoReview";
  // Preserve the existing shortcut location for installations without a choice.
  result.terminalLocation = saved.terminalLocation === "bottom" ? "bottom" : "right";
  result.showBottomPanelControl = saved.showBottomPanelControl !== false;
  for (const mode of ["light", "dark"] as const) {
    const p = saved[mode] ?? {},
      defaults = DEFAULT_PALETTES[mode];
    // Existing installations stored fonts globally. Until this mode has its own
    // font record, inherit those values; the next normal save persists both modes.
    const fonts = p.fonts ?? saved;
    result[mode] = {
      fonts: {
        uiFont: Object.hasOwn(UI_FONTS, fonts.uiFont) ? fonts.uiFont : "system",
        contentFont: Object.hasOwn(UI_FONTS, fonts.contentFont) ? fonts.contentFont : "inherit",
        codeFont: Object.hasOwn(CODE_FONTS, fonts.codeFont) ? fonts.codeFont : "system",
      },
      translucentSidebar: p.translucentSidebar !== false,
      background: validColor(p.background) ? p.background : defaults.background,
      foreground: validColor(p.foreground) ? p.foreground : defaults.foreground,
      accent: validColor(p.accent) ? p.accent : defaults.accent,
      contrast:
        Number.isFinite(p.contrast) && p.contrast >= 0 && p.contrast <= 100
          ? p.contrast
          : defaults.contrast,
    };
  }
  return result;
}
export function shouldSteer(
  followUp: ApplicationSettings["followUp"],
  invert = false,
) {
  return (followUp === "steer") !== invert;
}
