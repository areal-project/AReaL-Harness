import {
  getResolvedOrResolveTheme,
  registerCustomTheme,
  type HighlighterTypes,
} from "@pierre/diffs";
import type { WorkerInitializationRenderOptions } from "@pierre/diffs/react";
import type { CodePreviewTheme } from "./code-preview-settings.js";
import { SYNTAX_COLORS } from "../generated/syntax.js";

// 复用 @pierre/diffs 的 Pierre TextMate 范围（Apache-2.0），把它的色值按用途换成
// tokens.json 的 color-syntax-*；不复制参考主题实现，不覆盖用户保存的其它预设。
// File 与 Diff 都经过本模块注册，保持原 WASM 引擎与公共主题加载接口。
type SyntaxRole = keyof (typeof SYNTAX_COLORS)["light"];
const pierreRoles: Record<"light" | "dark", Record<string, SyntaxRole>> = {
  dark: {
    "#0a0a0a": "background",
    "#fafafa": "foreground",
    "#737373": "muted",
    "#a3a3a3": "muted",
    "#636363": "muted",
    "#5ecc71": "string",
    "#68cdf2": "literal",
    "#08c0ef": "literal",
    "#60d199": "literal",
    "#61d5c0": "literal",
    "#ffd452": "variable",
    "#ffab16": "variable",
    "#ffa359": "variable",
    "#ff678d": "keyword",
    "#ff855e": "keyword",
    "#9d6afb": "function",
    "#d568ea": "function",
    "#64d1db": "regexp",
    "#69b1ff": "decorator",
  },
  light: {
    "#ffffff": "background",
    "#0a0a0a": "foreground",
    "#737373": "muted",
    "#636363": "muted",
    "#199f43": "string",
    "#1ca1c7": "literal",
    "#08c0ef": "literal",
    "#18a46c": "literal",
    "#16a994": "literal",
    "#d5a910": "variable",
    "#d5901c": "variable",
    "#d47628": "variable",
    "#d32a61": "keyword",
    "#d5512f": "keyword",
    "#693acf": "function",
    "#a631be": "function",
    "#17a5af": "regexp",
    "#1a85d4": "decorator",
  },
};

const errorScopes = ["invalid.illegal.non-null-typehinted.php", "token.error-token"];
const whiteScopes = [
  "constant.other.color.rgb-value.xi",
  "invalid.illegal",
  "invalid.broken",
  "invalid.deprecated",
  "invalid.unimplemented",
];

for (const mode of ["light", "dark"] as const) {
  registerCustomTheme(`areal-${mode}`, async () => {
    const base = await getResolvedOrResolveTheme(`pierre-${mode}`);
    const syntax = SYNTAX_COLORS[mode];
    const roles = pierreRoles[mode];
    const recolor = (color: string) => {
      const role = roles[color.toLowerCase()];
      return role ? syntax[role] : color;
    };
    const scopeForeground = (scope: string) =>
      errorScopes.includes(scope)
        ? syntax.error
        : whiteScopes.includes(scope)
          ? "#ffffff"
          : undefined;
    return {
      ...base,
      name: `areal-${mode}`,
      displayName: `AReaL ${mode === "dark" ? "Dark" : "Light"}`,
      fg: recolor(base.fg),
      bg: recolor(base.bg),
      colors: Object.fromEntries(
        Object.entries(base.colors ?? {}).map(([key, color]) => [key, recolor(color)]),
      ),
      settings: base.settings.map((rule) => {
        const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
        const foreground = scopes
          .map((scope) => (scope == null ? undefined : scopeForeground(scope)))
          .find((color) => color != null);
        return {
          ...rule,
          settings: {
            ...rule.settings,
            foreground:
              foreground ??
              (rule.settings.foreground == null ? undefined : recolor(rule.settings.foreground)),
            background:
              rule.settings.background == null ? undefined : recolor(rule.settings.background),
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
