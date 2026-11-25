import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";

export type KbdProps = ComponentProps<"kbd"> & {
  /** primary：用于主动作按钮内；secondary：用于次按钮或菜单项内；keycap：独立键帽展示。 */
  variant?: "secondary" | "primary" | "keycap";
};

/** 统一的快捷键提示原语，按宿主背景自动协调对比度，避免暗色反色黑块。 */
export function Kbd({ variant = "secondary", className, ...props }: KbdProps) {
  return (
    <kbd
      aria-hidden="true"
      data-slot="kbd"
      data-variant={variant}
      className={cn("areal-kbd", className)}
      {...props}
    />
  );
}
