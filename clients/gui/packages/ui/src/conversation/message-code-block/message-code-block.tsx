import { useState, type CSSProperties, type ComponentType, type ReactNode } from "react";
import { Check, Code2, Copy, Eye, WrapText } from "lucide-react";
import { Button } from "../../components/button/button.js";
import { CodeViewer, type CodeViewerProps } from "../../components/code-viewer/code-viewer.js";

const codeStyle: CSSProperties & Record<`--${string}`, string> = {
  "--diffs-bg": "transparent",
  "--diffs-light-bg": "transparent",
  "--diffs-dark-bg": "transparent",
  "--diffs-gap-block": "0px",
  "--diffs-gap-inline": "0px",
};

export type MessageCodeBlockLabels = {
  codeRegion?: (language: string) => string;
  wrap?: string;
  enableWrap?: string;
  disableWrap?: string;
  copy?: string;
  copied?: string;
  copyFailed?: string;
};

/** Presentation only: the existing viewer owns highlighting and line wrapping. */
export function MessageCodeBlock({
  code,
  language,
  streaming,
  fontSizePx,
  CodeComponent = CodeViewer,
  preview,
  previewActions,
  previewLabel = "预览图形",
  sourceLabel = "查看源码",
  labels,
}: {
  preview?: ReactNode;
  previewActions?: ReactNode;
  previewLabel?: string;
  sourceLabel?: string;
  labels?: MessageCodeBlockLabels;
  code: string;
  language: string;
  streaming: boolean;
  fontSizePx: number;
  CodeComponent?: ComponentType<CodeViewerProps>;
}) {
  const [showSource, setShowSource] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const viewerStyle: typeof codeStyle = {
    ...codeStyle,
    "--diffs-line-height": `${fontSizePx + 8}px`,
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  const copyLabel = labels?.copy ?? "复制代码";
  const wrapTitle = labels?.wrap ?? "自动换行";
  return (
    <section
      className="conversation-code-block"
      aria-label={labels?.codeRegion ? labels.codeRegion(language) : `${language} 代码`}
    >
      <div className="conversation-code-header">
        <Code2 size={20} aria-hidden="true" />
        <span>{language}</span>
        <div className="conversation-code-actions">
          {preview && previewActions}
          {preview && (
            <>
              <Button
                variant="ghost"
                aria-label={previewLabel}
                title={previewLabel}
                aria-pressed={!showSource}
                onClick={() => setShowSource(false)}
              >
                <Eye size={16} />
              </Button>
              <Button
                variant="ghost"
                aria-label={sourceLabel}
                title={sourceLabel}
                aria-pressed={showSource}
                onClick={() => setShowSource(true)}
              >
                <Code2 size={16} />
              </Button>
            </>
          )}
          {(!preview || showSource) && (
            <Button
              variant="ghost"
              aria-label={
                wrap
                  ? (labels?.disableWrap ?? "禁用自动换行")
                  : (labels?.enableWrap ?? "启用自动换行")
              }
              title={wrapTitle}
              aria-pressed={wrap}
              onClick={() => setWrap((value) => !value)}
            >
              <WrapText size={16} />
            </Button>
          )}
          <Button
            variant="ghost"
            aria-label={copyLabel}
            title={copyLabel}
            onClick={() => void copy()}
          >
            {copyState === "copied" ? <Check size={16} /> : <Copy size={16} />}
          </Button>
        </div>
      </div>
      {copyState !== "idle" && (
        <span className="sr-only" role="status">
          {copyState === "copied"
            ? (labels?.copied ?? "代码已复制")
            : (labels?.copyFailed ?? "复制失败，请选择代码手动复制")}
        </span>
      )}
      {preview && (
        <div className="conversation-code-preview" hidden={showSource}>
          {preview}
        </div>
      )}
      <div className="conversation-code-content" hidden={!!preview && !showSource}>
        <CodeComponent
          code={code}
          language={language}
          fontSizePx={fontSizePx}
          showLineNumbers={false}
          transparentBackground
          wrapLongLines={wrap}
          enableSyntaxHighlighting={!streaming}
          style={viewerStyle}
        />
      </div>
    </section>
  );
}
