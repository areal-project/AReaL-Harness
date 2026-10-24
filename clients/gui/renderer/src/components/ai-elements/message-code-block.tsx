import { useI18n } from "../../i18n/IntlProvider.js";
import { Streamdown } from "streamdown";
import { mermaid } from "@streamdown/mermaid";
import type { ComponentProps } from "react";
import { MessageCodeBlock as View } from "@areal/ui/wip";
import { CodeViewer } from "../ui/code-viewer.js";
const diagramPlugins = { mermaid };
function DiagramError() { const { t } = useI18n(); return <p role="status">{t("content.diagramUnavailable")}</p>; }
function DiagramPreview({ code, theme }: { code: string; theme: "light" | "dark" }) {
  // 通过公开Streamdown入口使用既有图形渲染；围栏长度避免源代码意外闭合外层。
  const fence = "`".repeat(Math.max(3, ...(code.match(/^`+/gm) ?? []).map(run => run.length + 1)));
  const source = [fence + "mermaid", code, fence].join("\n");
  return <Streamdown key={theme} mode="static" parseIncompleteMarkdown={false} plugins={diagramPlugins} controls={false}
    mermaid={{ config: { theme: theme === "dark" ? "dark" : "default", securityLevel: "strict", flowchart: { htmlLabels: false }, fontFamily: "var(--font-sans)" }, errorComponent: DiagramError }}>{source}</Streamdown>;
}
export function MessageCodeBlock({ theme = "light", ...props }: Omit<ComponentProps<typeof View>, "CodeComponent" | "preview"> & { theme?: "light" | "dark" }) {
  const { t } = useI18n();
  return <View {...props} CodeComponent={CodeViewer} previewLabel={t("content.diagramPreview")} sourceLabel={t("content.diagramSource")} preview={props.language === "mermaid" && !props.streaming ? <DiagramPreview code={props.code} theme={theme} /> : undefined} />;
}
