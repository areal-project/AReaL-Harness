import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

/** The editor and actions belong to the host; this surface owns only their layout. */
export function ComposerSurface({
  editor,
  toolbar,
  context,
  overlay,
  dragging = false,
  layout = "default",
  placement = "thread",
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  editor: ReactNode;
  toolbar: ReactNode;
  context?: ReactNode;
  overlay?: ReactNode;
  dragging?: boolean;
  layout?: "default" | "compact" | "decision";
  /** Where the surface sits; each placement owns its own look so pages never restyle it. */
  placement?: "thread" | "home" | "inline";
}) {
  return (
    <div
      {...props}
      className={cn("composer-surface", className)}
      data-dragging={dragging || undefined}
      data-layout={layout}
      data-placement={placement}
    >
      {overlay}
      {context}
      <div className="composer-editor">{editor}</div>
      {toolbar}
    </div>
  );
}
