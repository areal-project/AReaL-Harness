import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export type EmptyStateProps = Omit<ComponentProps<"div">, "title"> & {
  /** 说明这里承载什么或当前为何为空（避免孤立“暂无数据”）。 */
  title: ReactNode;
  /** 补充背景说明或第一步指引。 */
  description?: ReactNode;
  /** 装饰性图标，组件自动标记 aria-hidden。 */
  icon?: ReactNode;
  /** 唯一核心主动作按钮。 */
  action?: ReactNode;
  /** 可选的次要辅助动作。 */
  secondaryAction?: ReactNode;
  /** 密度：default 用于整页/主内容区，compact 用于卡片或侧栏内。 */
  size?: "default" | "compact";
};

/** 居中克制的空状态原语：明确说明此处承载什么，并提供清晰的第一步行动引导。 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  secondaryAction,
  size = "default",
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      data-size={size}
      className={cn("areal-empty-state", className)}
      {...props}
    >
      {icon && (
        <div className="areal-empty-state-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="areal-empty-state-copy">
        <div className="areal-empty-state-title">{title}</div>
        {description && <div className="areal-empty-state-description">{description}</div>}
      </div>
      {(action || secondaryAction) && (
        <div className="areal-empty-state-actions">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
