import { Textarea } from "@areal/ui";
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Check, SlidersHorizontal } from "lucide-react";
import { Button } from "./components/ui/button.js";
import "./AnnotationNoteEditor.css";

export function AnnotationNoteEditor({
  number,
  comment,
  busy = false,
  valid = true,
  expanded,
  onExpandedChange,
  details,
  style,
  onChange,
  onConfirm,
  onCancel,
}: {
  number: number;
  comment: string;
  busy?: boolean;
  valid?: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  details?: ReactNode;
  style?: CSSProperties;
  onChange: (comment: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const disabled = busy || !valid || !comment.trim();
  useLayoutEffect(() => {
    if (!busy) input.current?.focus();
  }, [busy, expanded]);
  const confirm = () => {
    if (!disabled) onConfirm();
  };
  return (
    <div
      className={`browser-annotation-editor ${expanded ? "expanded" : ""}`}
      role="dialog"
      aria-label="编辑当前标注"
      style={style}
    >
      <div className="browser-annotation-editor-row">
        <Button
          unstyled
          data-slot={undefined}
          type="button"
          aria-label="展开批注编辑"
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
        >
          <SlidersHorizontal size={15} />
        </Button>
        {!expanded ? (
          <Textarea
            unstyled
            data-slot={undefined}
            ref={input}
            rows={1}
            aria-label="标注意见"
            placeholder={`批注 ${number}`}
            maxLength={4000}
            value={comment}
            disabled={busy}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                confirm();
              }
            }}
          />
        ) : (
          <span>批注 {number}</span>
        )}
        {!expanded && (
          <span className="shrink-0">
            <Button
              type="button"
              variant="default"
              size="icon"
              shape="pill"
              aria-label="加入聊天草稿"
              title="确认批注，加入 Composer"
              disabled={disabled}
              onClick={confirm}
            >
              <Check size={14} />
            </Button>
          </span>
        )}
      </div>
      {expanded && (
        <>
          {details && <small>{details}</small>}
          <Textarea
            unstyled
            data-slot={undefined}
            ref={input}
            aria-label="标注意见"
            value={comment}
            disabled={busy}
            maxLength={4000}
            placeholder="描述想调整的内容…"
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                confirm();
              }
            }}
          />
          <div className="browser-annotation-editor-actions">
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
              取消此条
            </Button>
            <Button
              type="button"
              variant="default"
              size="icon"
              shape="pill"
              aria-label="加入聊天草稿"
              disabled={disabled}
              onClick={confirm}
            >
              <Check size={14} />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
