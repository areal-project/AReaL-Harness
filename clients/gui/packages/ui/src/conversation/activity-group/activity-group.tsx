import type { ReactNode } from "react";
import { ActivityIcon } from "../../activity-icons.js";
import { Disclosure } from "../../components/disclosure/disclosure.js";

export type ActivityGroupProps = {
  label: string;
  /** 可选耗时或阶段副标（如 worked-for 汇总），与摘要同行低对比度展示。 */
  duration?: string;
  /** 当前组正在活跃执行时启用轻柔扫光聚焦，减少动效时自动静止。 */
  active?: boolean;
  listLabel?: string;
  presentation?: "collapsible" | "inline";
  children: ReactNode;
  icon?: ReactNode;
  indicator?: ReactNode;
  status?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** A reading group, not an event grouper or execution-state owner. */
export function ActivityGroup({
  label,
  duration,
  active = false,
  listLabel = "分组活动列表",
  children,
  icon,
  indicator,
  status,
  presentation,
  open,
  onOpenChange,
}: ActivityGroupProps) {
  return (
    <div
      className="areal-activity-group"
      data-presentation={presentation}
      data-active={active || undefined}
    >
      <Disclosure
        presentation={presentation}
        open={open}
        onOpenChange={onOpenChange}
        label={label}
        meta={duration ? <span className="areal-activity-duration">{duration}</span> : undefined}
        icon={icon}
        indicator={indicator ?? <ActivityIcon kind="chevron" size={14} />}
        keepMounted
      >
        <div className="areal-activity-list" role="region" aria-label={listLabel} tabIndex={0}>
          {children}
        </div>
      </Disclosure>
      {status && <div className="areal-activity-status">{status}</div>}
    </div>
  );
}
