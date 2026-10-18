import type { ComponentProps, ReactNode } from "react";
import { cn } from "../components/lib/utils.js";

/** The editor and actions belong to the host; this surface owns only their layout. */
export function ComposerSurface({ editor, toolbar, context, overlay, dragging = false, className, ...props }: Omit<ComponentProps<"div">, "children"> & {
  editor: ReactNode;
  toolbar: ReactNode;
  context?: ReactNode;
  overlay?: ReactNode;
  dragging?: boolean;
}) {
  return <div {...props} className={cn("composer-surface", className)} data-dragging={dragging || undefined}>
    {overlay}
    {context}
    <div className="composer-editor">{editor}</div>
    {toolbar}
  </div>;
}

export function ComposerToolbar({ leading, trailing, className, ...props }: Omit<ComponentProps<"div">, "children"> & { leading: ReactNode; trailing: ReactNode }) {
  return <div {...props} className={cn("group/toolbar composer-toolbar", className)}>
    <div className="flex min-w-0 flex-1 items-center" data-composer-leading-actions>
      <div className="flex shrink-0 items-center gap-1" data-composer-leading-content>{leading}</div>
    </div>
    <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5" data-composer-trailing-actions>{trailing}</div>
  </div>;
}
