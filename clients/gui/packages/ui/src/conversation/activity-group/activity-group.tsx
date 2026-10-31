import type { ReactNode } from "react";
import { ActivityIcon } from "../../activity-icons.js";
import { Disclosure } from "../../components/disclosure/disclosure.js";

export type ActivityGroupProps = {
  label: string;
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
  children,
  icon,
  indicator,
  status,
  presentation,
  open,
  onOpenChange,
}: ActivityGroupProps) {
  return (
    <div className="areal-activity-group" data-presentation={presentation}>
      <Disclosure
        presentation={presentation}
        open={open}
        onOpenChange={onOpenChange}
        label={label}
        icon={icon}
        indicator={indicator ?? <ActivityIcon kind="chevron" size={14} />}
        keepMounted
      >
        <div className="areal-activity-list" role="region" aria-label="分组活动列表" tabIndex={0}>
          {children}
        </div>
      </Disclosure>
      {status && <div className="areal-activity-status">{status}</div>}
    </div>
  );
}
