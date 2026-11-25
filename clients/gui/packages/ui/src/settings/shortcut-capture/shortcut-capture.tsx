import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "../../components/button/button.js";
import { Kbd } from "../../components/kbd/kbd.js";
import { TitleTooltip } from "../../components/tooltip/tooltip.js";
import { cn } from "../../lib/utils.js";

export type ShortcutCaptureProps = {
  value: string;
  onChange: (shortcut: string) => void;
  onReset?: () => void;
  label: string;
  recordingPrompt?: string;
  emptyLabel?: string;
  resetLabel?: string;
  disabled?: boolean;
  className?: string;
};

function formatKeyCombo(event: React.KeyboardEvent<HTMLButtonElement>): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return null;
  const parts: string[] = [];
  if (event.metaKey) parts.push("⌘");
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("⌥");
  if (event.shiftKey) parts.push("⇧");
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  parts.push(key);
  return parts.join("+");
}

/** 快捷键录制框（对标 Codex data-codex-shortcut-capture），点击进入监听态并按 Esc 取消。 */
export function ShortcutCapture({
  value,
  onChange,
  onReset,
  label,
  recordingPrompt = "请按下快捷键…",
  emptyLabel = "未设置",
  resetLabel = "恢复默认快捷键",
  disabled = false,
  className,
}: ShortcutCaptureProps) {
  const [recording, setRecording] = useState(false);

  return (
    <div
      data-slot="shortcut-capture"
      data-recording={recording || undefined}
      className={cn("areal-shortcut-capture", className)}
    >
      <button
        type="button"
        className="areal-shortcut-capture-button"
        aria-label={label}
        aria-pressed={recording}
        disabled={disabled}
        onClick={() => setRecording((prev) => !prev)}
        onBlur={() => setRecording(false)}
        onKeyDown={(event) => {
          if (!recording || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") {
            setRecording(false);
            return;
          }
          if (event.key === "Backspace" || event.key === "Delete") {
            onChange("");
            setRecording(false);
            return;
          }
          const combo = formatKeyCombo(event);
          if (combo) {
            onChange(combo);
            setRecording(false);
          }
        }}
      >
        {recording ? (
          <span className="areal-shortcut-capture-prompt">{recordingPrompt}</span>
        ) : value ? (
          <Kbd variant="keycap">{value}</Kbd>
        ) : (
          <span className="areal-shortcut-capture-empty">{emptyLabel}</span>
        )}
      </button>
      {onReset && (
        <TitleTooltip title={resetLabel}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={resetLabel}
            disabled={disabled}
            onClick={onReset}
          >
            <RotateCcw size={14} />
          </Button>
        </TitleTooltip>
      )}
    </div>
  );
}
