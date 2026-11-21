import { useRef } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { Button } from "../../components/button/button.js";
import { Input } from "../../components/input/input.js";
import { TitleTooltip } from "../../components/tooltip/tooltip.js";
import { cn } from "../../lib/utils.js";

export type ThreadFindBarProps = {
  value: string;
  onChange: (value: string) => void;
  matchIndex?: number;
  matchCount?: number;
  onPrevious?: () => void;
  onNext?: () => void;
  onClose?: () => void;
  placeholder?: string;
  label?: string;
  previousLabel?: string;
  nextLabel?: string;
  closeLabel?: string;
  className?: string;
};

/** 会话内紧凑查找浮条（对标 Codex data-codex-find-input），支持 Enter/Shift+Enter 与 Esc 关闭。 */
export function ThreadFindBar({
  value,
  onChange,
  matchIndex = 0,
  matchCount = 0,
  onPrevious,
  onNext,
  onClose,
  placeholder = "在当前会话中查找…",
  label = "会话内查找",
  previousLabel = "上一个匹配",
  nextLabel = "下一个匹配",
  closeLabel = "关闭查找",
  className,
}: ThreadFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hasMatches = matchCount > 0;
  return (
    <div
      role="search"
      aria-label={label}
      data-slot="thread-find-bar"
      className={cn("areal-thread-find-bar", className)}
    >
      <Search size={14} className="areal-thread-find-icon" aria-hidden="true" />
      <Input
        ref={inputRef}
        type="search"
        value={value}
        aria-label={label}
        placeholder={placeholder}
        className="areal-thread-find-input"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape" && onClose) {
            event.preventDefault();
            onClose();
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) onPrevious?.();
            else onNext?.();
          }
        }}
      />
      {value.trim().length > 0 && (
        <span className="areal-thread-find-count" aria-live="polite">
          {hasMatches ? `${matchIndex + 1} / ${matchCount}` : "0 / 0"}
        </span>
      )}
      <span className="areal-thread-find-actions">
        <TitleTooltip title={previousLabel}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={previousLabel}
            disabled={!hasMatches}
            onClick={onPrevious}
          >
            <ChevronUp size={14} />
          </Button>
        </TitleTooltip>
        <TitleTooltip title={nextLabel}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={nextLabel}
            disabled={!hasMatches}
            onClick={onNext}
          >
            <ChevronDown size={14} />
          </Button>
        </TitleTooltip>
        {onClose && (
          <TitleTooltip title={closeLabel}>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={closeLabel}
              onClick={onClose}
            >
              <X size={14} />
            </Button>
          </TitleTooltip>
        )}
      </span>
    </div>
  );
}
