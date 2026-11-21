import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Pin, PinOff } from "lucide-react";
import { Button } from "../../components/button/button.js";
import { TitleTooltip } from "../../components/tooltip/tooltip.js";
import { cn } from "../../lib/utils.js";

export type ThreadSummaryPanelProps = {
  title: string;
  summary?: string;
  /** card：置顶展开卡片；compact：顶部紧凑浮条（灵动条形态）。 */
  variant?: "card" | "compact";
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  pinned?: boolean;
  onPinnedChange?: (pinned: boolean) => void;
  pinLabel?: string;
  unpinLabel?: string;
  toggleLabel?: string;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
};

/** 展示当前会话的置顶摘要，不持有业务数据或执行状态。 */
export function ThreadSummaryPanel({
  title,
  summary,
  variant = "card",
  open: controlledOpen,
  defaultOpen = true,
  onOpenChange,
  pinned = true,
  onPinnedChange,
  pinLabel = "固定摘要",
  unpinLabel = "取消固定摘要",
  toggleLabel = "展开或收起摘要",
  actions,
  children,
  className,
}: ThreadSummaryPanelProps) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  };
  const effectiveOpen = variant === "compact" ? false : open;
  const pinActionLabel = pinned ? unpinLabel : pinLabel;

  return (
    <section
      aria-label={title}
      className={cn("areal-thread-summary-panel", className)}
      data-slot="thread-summary-panel"
      data-variant={variant}
      data-open={effectiveOpen || undefined}
      data-pinned={pinned || undefined}
    >
      <div className="areal-thread-summary-header" data-slot="thread-summary-panel-header">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="areal-thread-summary-trigger"
          aria-expanded={effectiveOpen}
          aria-label={toggleLabel}
          onClick={() => setOpen(!effectiveOpen)}
        >
          <span className="areal-thread-summary-chevron" aria-hidden="true">
            {effectiveOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <span className="areal-thread-summary-title">{title}</span>
          {summary && !effectiveOpen && (
            <span className="areal-thread-summary-inline-meta">{summary}</span>
          )}
        </Button>
        <span
          className="areal-thread-summary-actions"
          data-slot="thread-summary-panel-section-actions"
        >
          {actions}
          {onPinnedChange && (
            <TitleTooltip title={pinActionLabel}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={pinActionLabel}
                aria-pressed={pinned}
                onClick={() => onPinnedChange(!pinned)}
              >
                {pinned ? <PinOff size={14} /> : <Pin size={14} />}
              </Button>
            </TitleTooltip>
          )}
        </span>
      </div>
      {effectiveOpen && children && (
        <div
          className="areal-thread-summary-body scrollbar-on-hover"
          data-slot="thread-summary-panel-body"
        >
          {children}
        </div>
      )}
    </section>
  );
}

export type ThreadSummaryItemProps = {
  icon?: ReactNode;
  label: string;
  meta?: ReactNode;
  actions?: ReactNode;
  tone?: "default" | "attention" | "muted";
  onClick?: () => void;
  className?: string;
};

/** 置顶摘要中的单条上下文条目：图标、主文案（尾部渐隐）、元信息与行内动作。 */
export function ThreadSummaryItem({
  icon,
  label,
  meta,
  actions,
  tone = "default",
  onClick,
  className,
}: ThreadSummaryItemProps) {
  const content = (
    <>
      {icon && (
        <span className="areal-thread-summary-item-leading" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="areal-thread-summary-item-label">{label}</span>
      {meta && <span className="areal-thread-summary-item-meta">{meta}</span>}
    </>
  );

  return (
    <div
      className={cn("areal-thread-summary-item", className)}
      data-slot="thread-summary-panel-item"
      data-tone={tone}
    >
      {onClick ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="areal-thread-summary-item-button"
          onClick={onClick}
        >
          {content}
        </Button>
      ) : (
        <div className="areal-thread-summary-item-static">{content}</div>
      )}
      {actions && (
        <span
          className="areal-thread-summary-item-actions"
          data-slot="thread-summary-panel-item-actions"
        >
          {actions}
        </span>
      )}
    </div>
  );
}
