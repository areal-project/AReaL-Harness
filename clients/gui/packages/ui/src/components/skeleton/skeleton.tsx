import type { ComponentProps } from "react";
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

export { Skeleton };
