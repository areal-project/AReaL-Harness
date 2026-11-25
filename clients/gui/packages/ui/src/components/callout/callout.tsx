import type { ComponentProps, ReactNode } from "react";
import { AlertTriangle, CircleAlert, Info } from "lucide-react";
import { cn } from "../../lib/utils.js";

export type CalloutProps = ComponentProps<"div"> & {
  tone?: "info" | "warning" | "danger" | "neutral";
  title?: string;
  icon?: ReactNode;
  actions?: ReactNode;
};

/** 轻量内联提示块，用于表单说明、审批原因与模板重置提醒。 */
export function Callout({
  tone = "info",
  title,
  icon,
  actions,
  className,
  children,
  ...props
}: CalloutProps) {
  const defaultIcon =
    tone === "danger" ? (
      <CircleAlert size={16} />
    ) : tone === "warning" ? (
      <AlertTriangle size={16} />
    ) : (
      <Info size={16} />
    );
  return (
    <div
      role={tone === "danger" ? "alert" : "note"}
      data-slot="callout"
      data-tone={tone}
      className={cn("areal-callout", className)}
      {...props}
    >
      <span className="areal-callout-icon" aria-hidden="true">
        {icon ?? defaultIcon}
      </span>
      <div className="areal-callout-body">
        {title && <div className="areal-callout-title">{title}</div>}
        <div className="areal-callout-content">{children}</div>
      </div>
      {actions && <div className="areal-callout-actions">{actions}</div>}
    </div>
  );
}
