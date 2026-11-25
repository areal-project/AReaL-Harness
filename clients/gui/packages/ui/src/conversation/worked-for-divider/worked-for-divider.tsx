import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export type WorkedForDividerProps = ComponentProps<"div"> & {
  label: string;
  meta?: ReactNode;
  onClick?: () => void;
};

/** 过程活动与最终结论之间的耗时分隔条（对标 Codex worked-for 节点）。 */
export function WorkedForDivider({
  label,
  meta,
  onClick,
  className,
  ...props
}: WorkedForDividerProps) {
  return (
    <div
      role="separator"
      aria-label={label}
      data-slot="worked-for-divider"
      className={cn("areal-worked-for-divider", className)}
      {...props}
    >
      {onClick ? (
        <button type="button" className="areal-worked-for-trigger" onClick={onClick}>
          <span>{label}</span>
        </button>
      ) : (
        <span className="areal-worked-for-label">{label}</span>
      )}
      <span className="areal-worked-for-line" aria-hidden="true" />
      {meta && <span className="areal-worked-for-meta">{meta}</span>}
    </div>
  );
}
