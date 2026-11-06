import { useApplicationPreferences } from "./applicationPreferences.js";

const THEME_DIFF = {
  remove: [
    "const themePreview: ThemeConfig = {",
    '  surface: "sidebar",',
    '  accent: "#2563eb",',
    "  contrast: 42,",
    "};",
  ],
  add: [
    "const themePreview: ThemeConfig = {",
    '  surface: "sidebar-elevated",',
    '  accent: "#0ea5e9",',
    "  contrast: 68,",
    "};",
  ],
} as const;

function highlightThemeLine(line: string) {
  return line
    .split(/(\bconst\b|"[^"]*"|\b\d+\b|[A-Za-z_]\w*|[{}:=,])/g)
    .filter(Boolean)
    .map((part, index) => {
      const kind =
        part === "const"
          ? "keyword"
          : part === "ThemeConfig"
            ? "type"
            : part === "="
              ? "operator"
              : part.startsWith('"')
                ? "string"
                : /^\d+$/.test(part)
                  ? "number"
                  : /^[A-Za-z_]/.test(part)
                    ? "ident"
                    : "punct";
      return (
        <span key={`${part}-${index}`} className={`tok-${kind}`}>
          {part}
        </span>
      );
    });
}

export function ThemeDiffPreview() {
  const { diffMarkers } = useApplicationPreferences();
  return (
    <div className="theme-diff" data-diff-markers={diffMarkers} aria-hidden="true">
      {(["remove", "add"] as const).map((tone) => (
        <div key={tone} className={`theme-diff-pane theme-diff-${tone}`}>
          <div className="theme-diff-gutter">
            {THEME_DIFF[tone].map((_, index) => (
              <span key={index} data-changed={index > 0 && index < 4 ? "true" : undefined}>
                {index + 1}
                {diffMarkers === "signs" && index > 0 && index < 4 && (
                  <span className="theme-diff-marker">{tone === "add" ? "+" : "−"}</span>
                )}
              </span>
            ))}
          </div>
          <div className="theme-diff-code">
            {THEME_DIFF[tone].map((line, index) => (
              <span
                key={line}
                className="theme-diff-line"
                data-changed={index > 0 && index < 4 ? "true" : undefined}
              >
                {highlightThemeLine(line)}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
