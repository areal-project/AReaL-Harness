import type { ButtonHTMLAttributes, HTMLAttributes, ReactElement, ReactNode } from "react";
import { ActivityIcon } from "../../activity-icons.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/tooltip/tooltip.js";
import { cn } from "../../lib/utils.js";

type RowProps = {
  icon?: ReactNode;
  variant?: "default" | "image" | "file";
} & HTMLAttributes<HTMLDivElement>;
type RowButtonProps = {
  icon?: ReactNode;
  variant?: "default" | "reasoning";
} & ButtonHTMLAttributes<HTMLButtonElement>;

/** One fact in the conversation timeline: icon, text, optional status and actions. */
export function ActivityRow({
  icon,
  variant = "default",
  className,
  children,
  ...props
}: RowProps) {
  return (
    <div
      {...props}
      className={cn(
        "areal-activity-row tool-summary-row",
        variant === "image" && "tool-image-row",
        variant === "file" && "tool-file-row",
        className,
      )}
    >
      {icon}
      {children}
    </div>
  );
}

/** A row whose whole surface toggles its own details. */
export function ActivityRowButton({
  icon,
  variant = "default",
  className,
  children,
  type = "button",
  ...props
}: RowButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={cn(
        "areal-activity-row tool-summary-row",
        variant === "reasoning" && "reasoning-summary",
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * Verb stays whole; the object truncates first. `detailHint` is the full value (absolute path,
 * whole command) shown on hover or keyboard focus, so a short name never hides what was touched.
 */
export function ActivityRowText({
  action,
  detail,
  detailHint,
  running,
  className,
}: {
  action: ReactNode;
  detail?: ReactNode;
  detailHint?: string;
  running?: boolean;
  className?: string;
}) {
  const hasDetail = detail != null && detail !== "";
  return (
    <span className={cn("areal-activity-row-text", className)} data-running={running || undefined}>
      <span className="areal-activity-row-action">{action}</span>
      {hasDetail &&
        (detailHint ? (
          <ActivityRowHint hint={detailHint}>
            <span className="areal-activity-row-detail" data-hint="">
              {detail}
            </span>
          </ActivityRowHint>
        ) : (
          <span className="areal-activity-row-detail">{detail}</span>
        ))}
    </span>
  );
}

/** Full value of a shortened object (path, command) on hover; `children` is the visible trigger. */
export function ActivityRowHint({ hint, children }: { hint: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent className="areal-activity-row-hint" side="top" align="start">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

/** Non-default outcomes stay visible on the row; a hidden status still reaches assistive tech. */
export function ActivityRowStatus({
  tone,
  hidden,
  className,
  children,
}: {
  tone?: "failed";
  hidden?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn("areal-activity-row-status", className)}
      data-tone={tone}
      data-visually-hidden={hidden || undefined}
    >
      {children}
    </span>
  );
}

/** Shown on hover, keyboard focus or while open; the direction alone says open or closed. */
export function ActivityRowChevron({ open, className }: { open?: boolean; className?: string }) {
  return (
    <span className={cn("areal-activity-row-chevron", className)} data-open={open || undefined}>
      <ActivityIcon kind="chevron" size={14} />
    </span>
  );
}
