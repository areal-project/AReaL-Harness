import { getResolvedOrResolveTheme, registerCustomTheme, type HighlighterTypes } from "@pierre/diffs";
import type { WorkerInitializationRenderOptions } from "@pierre/diffs/react";
import type { CodePreviewTheme } from "./codePreviewSettings.js";

// 复用 @pierre/diffs 的 Pierre TextMate 范围（Apache-2.0），只适配实机观察的
// Codex 26.924.22138 色值；不复制参考主题实现，不覆盖用户保存的其它预设。
// File 与 Diff 都经过本模块注册，保持原 WASM 引擎与公共主题加载接口。
const palette = {
  dark: {
    "#fafafa": "#fcfcfc", "#0a0a0a": "#111111", "#737373": "#999999",
    "#5ecc71": "#85df7b", "#68cdf2": "#6dcbf4", "#ffd452": "#fa994c",
    "#ffab16": "#fa994c", "#ff678d": "#f67576", "#ffa359": "#fa994c",
    "#a3a3a3": "#999999", "#9d6afb": "#b06dff", "#d568ea": "#b06dff",
    "#636363": "#999999", "#08c0ef": "#6dcbf4", "#ff855e": "#f67576",
    "#60d199": "#6dcbf4", "#64d1db": "#3d8dff", "#61d5c0": "#6dcbf4",
  },
  light: {
    "#0a0a0a": "#0d0d0d", "#737373": "#666666", "#199f43": "#008809",
    "#1ca1c7": "#0071ea", "#d5a910": "#bd5800", "#d5901c": "#bd5800",
    "#d32a61": "#d53538", "#d47628": "#bd5800", "#636363": "#666666",
    "#693acf": "#751ed9", "#a631be": "#751ed9", "#08c0ef": "#0071ea",
    "#d5512f": "#d53538", "#18a46c": "#0071ea", "#17a5af": "#001bcb",
    "#16a994": "#0071ea",
  },
} satisfies Record<"light" | "dark", Record<string, string>>;

const scopeForeground: Record<string, string> = {
  "invalid.illegal.non-null-typehinted.php": "#f44747",
  "token.error-token": "#f44747",
  "constant.other.color.rgb-value.xi": "#ffffff",
  "invalid.illegal": "#ffffff", "invalid.broken": "#ffffff",
  "invalid.deprecated": "#ffffff", "invalid.unimplemented": "#ffffff",
};

for (const mode of ["light", "dark"] as const) {
  registerCustomTheme(`areal-${mode}`, async () => {
    const base = await getResolvedOrResolveTheme(`pierre-${mode}`);
    const colors: Record<string, string> = palette[mode];
    const recolor = (color: string) => colors[color.toLowerCase()] ?? color;
    return {
      ...base,
      name: `areal-${mode}`,
      displayName: `AReaL ${mode === "dark" ? "Dark" : "Light"}`,
      fg: recolor(base.fg),
      bg: recolor(base.bg),
      colors: Object.fromEntries(Object.entries(base.colors ?? {}).map(([key, color]) => [key, recolor(color)])),
      settings: base.settings.map(rule => {
        const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
        const foreground = scopes.map(scope => scope == null ? undefined : scopeForeground[scope]).find(color => color != null);
        return {
          ...rule,
          settings: {
            ...rule.settings,
            foreground: foreground ?? (rule.settings.foreground == null ? undefined : recolor(rule.settings.foreground)),
            background: rule.settings.background == null ? undefined : recolor(rule.settings.background),
          },
        };
      }),
    };
  });
}

/**
 * @pierre/diffs 默认使用 shiki 的 JavaScript 正则引擎（shiki-js）。该引擎把 TextMate
 * 语法逐条翻译成巨型 RegExp 并在引擎级缓存里永久持有，V8 会把执行过的正则编译成原生代码放进
 * code space；双字节文本（中文注释等）还会再编译一份。主窗口和 4 个 diff worker 共用同一个
 * 256MB code range，长时间运行后会被这些正则占满，触发 renderer 的 V8 OOM
 * （CALL_AND_RETRY_LAST，old-space 仍有大量空闲，code cage "ran out of reservation"）。
 * oniguruma WASM 引擎的正则活在 wasm 线性内存里，不占 V8 代码区，且是 TextMate 语法的参考实现。
 */
export const DIFFS_PREFERRED_HIGHLIGHTER: HighlighterTypes = "shiki-wasm";

interface DiffsHighlighterThemeSettings {
  lightTheme: CodePreviewTheme;
  darkTheme: CodePreviewTheme;
}

/** diff worker 池初始化参数；主线程兜底渲染与 worker 必须使用同一个引擎选择。 */
export function createDiffsWorkerHighlighterOptions(
  settings: DiffsHighlighterThemeSettings,
): WorkerInitializationRenderOptions {
  return {
    theme: {
      light: settings.lightTheme,
      dark: settings.darkTheme,
    },
    // 不同 patch 的逐词差异计算会额外占用主线程；先沿用库默认阈值，
    // 后续可基于慢日志再单独收紧，避免一次改动引入“高亮信息突然消失”的回归。
    lineDiffType: "word-alt",
    maxLineDiffLength: 1_000,
    tokenizeMaxLineLength: 1_000,
    useTokenTransformer: false,
    preferredHighlighter: DIFFS_PREFERRED_HIGHLIGHTER,
  };
}
