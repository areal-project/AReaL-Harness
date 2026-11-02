import type { ComponentProps, ReactNode } from "react";
import { useDelayedVisible } from "../../lib/delayed-visibility.js";
import { cn } from "../../lib/utils.js";

/** 内容占位条。只在加载持续一会儿后出现，配合 useDelayedVisible 使用。 */
function Skeleton({
  className,
  shape = "line",
  ...props
}: ComponentProps<"div"> & { shape?: "line" | "block" | "pill" }) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      data-shape={shape}
      className={cn("areal-skeleton", className)}
      {...props}
    />
  );
}

/** 加载提示的声明式写法：active 持续 400ms 后才渲染 children，出现后至少保留 400ms。保持挂载才能保证最短停留。 */
function DelayedVisible({ active, children }: { active: boolean; children: ReactNode }) {
  return useDelayedVisible(active) ? children : null;
}

export { DelayedVisible, Skeleton };
