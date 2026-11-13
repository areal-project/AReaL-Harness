import { useI18n } from "../../i18n/IntlProvider.js";
import { Streamdown, useIsCodeFenceIncomplete } from "streamdown";
import { mermaid } from "@streamdown/mermaid";
import { memo, type ComponentProps } from "react";
import { Maximize2 } from "lucide-react";
import { MessageCodeBlock as View } from "@areal/ui/experimental";
import { CodeViewer } from "../ui/code-viewer.js";
import { Button } from "../ui/button.js";
const diagramPlugins = { mermaid };
function DiagramError() {
  const { t } = useI18n();
  return <p role="status">{t("content.diagramUnavailable")}</p>;
}
export const DiagramPreview = memo(function DiagramPreview({
  code,
  theme,
}: {
  code: string;
  theme: "light" | "dark";
}) {
  // 通过公开Streamdown入口使用既有图形渲染；围栏长度避免源代码意外闭合外层。
  const fence = "`".repeat(
    Math.max(3, ...(code.match(/^`+/gm) ?? []).map((run) => run.length + 1)),
  );
  const source = [fence + "mermaid", code, fence].join("\n");
  return (
    <Streamdown
      key={theme}
      mode="static"
      parseIncompleteMarkdown={false}
      plugins={diagramPlugins}
      controls={false}
      mermaid={{
        config: {
          theme: theme === "dark" ? "dark" : "default",
          securityLevel: "strict",
          flowchart: { htmlLabels: false },
          fontFamily: "var(--font-sans)",
        },
        errorComponent: DiagramError,
      }}
    >
      {source}
    </Streamdown>
  );
});
export function MessageCodeBlock({
  theme = "light",
  readerScope,
  onExpandDiagram,
  ...props
}: Omit<ComponentProps<typeof View>, "CodeComponent" | "preview" | "previewActions"> & {
  theme?: "light" | "dark";
  readerScope: string;
  onExpandDiagram: (code: string, trigger: HTMLButtonElement) => void;
}) {
  const { t } = useI18n();
  const incomplete = useIsCodeFenceIncomplete();
  const diagramReady = props.language === "mermaid" && !(props.streaming && incomplete);
  return (
    <View
      {...props}
      CodeComponent={CodeViewer}
      previewLabel={t("content.diagramPreview")}
      sourceLabel={t("content.diagramSource")}
      previewActions={
        <Button
          variant="ghost"
          className="conversation-diagram-expand"
          data-diagram-reader={readerScope}
          onClick={(event) => onExpandDiagram(props.code, event.currentTarget)}
        >
          <Maximize2 size={16} />
          {t("content.expand")}
        </Button>
      }
      preview={diagramReady ? <DiagramPreview code={props.code} theme={theme} /> : undefined}
    />
  );
}
