import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../../components/button/button.js";
import { Badge } from "../../components/badge/badge.js";
import { cn } from "../../lib/utils.js";

export type ComposerRequestStackProps = {
  /** 当前展示的请求索引（从 0 开始）。 */
  index: number;
  /** 待处理请求总数。 */
  total: number;
  onIndexChange: (nextIndex: number) => void;
  label?: string;
  previousLabel?: string;
  nextLabel?: string;
  children?: ReactNode;
  className?: string;
};

/** 底部请求导航栈（对标 Codex data-codex-composer-request-navigation），在多审批/问答并存时提供 1 / N 切换。 */
export function ComposerRequestStack({
  index,
  total,
  onIndexChange,
  label = "待处理请求",
  previousLabel = "上一项请求",
  nextLabel = "下一项请求",
  children,
  className,
}: ComposerRequestStackProps) {
  const safeIndex = total > 0 ? Math.min(Math.max(index, 0), total - 1) : 0;
  return (
    <section
      aria-label={label}
      data-slot="composer-request-stack"
      className={cn("areal-composer-request-stack", className)}
    >
      {total > 1 && (
        <div className="areal-composer-request-nav" data-slot="composer-request-navigation">
          <Badge tone="warning" size="sm">
            {label}
          </Badge>
          <span className="areal-composer-request-pager">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={previousLabel}
              disabled={safeIndex <= 0}
              onClick={() => onIndexChange(safeIndex - 1)}
            >
              <ChevronLeft size={14} />
            </Button>
            <span className="areal-composer-request-count" aria-live="polite">
              {safeIndex + 1} / {total}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={nextLabel}
              disabled={safeIndex >= total - 1}
              onClick={() => onIndexChange(safeIndex + 1)}
            >
              <ChevronRight size={14} />
            </Button>
          </span>
        </div>
      )}
      <div className="areal-composer-request-body">{children}</div>
    </section>
  );
}
