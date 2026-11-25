import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export type BadgeProps = ComponentProps<"span"> & {
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  size?: "sm" | "md";
  icon?: ReactNode;
};

/** 通用语义状态徽标，用于计数、状态标签与来源标识。 */
export function Badge({
  tone = "neutral",
  size = "sm",
  icon,
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      data-slot="badge"
      data-tone={tone}
      data-size={size}
      className={cn("areal-badge", className)}
      {...props}
    >
      {icon && (
        <span className="areal-badge-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span>{children}</span>
    </span>
  );
}
