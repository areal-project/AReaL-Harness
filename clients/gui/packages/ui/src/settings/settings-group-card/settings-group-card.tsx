import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export function SettingsGroupCard({
  children,
  className,
  density,
  layout,
}: {
  children: ReactNode;
  className?: string;
  density?: "compact";
  layout?: "grid" | "stack" | "stack-gap";
}) {
  return (
    <div
      data-density={density}
      data-layout={layout}
      className={cn("settings-group-card", className)}
    >
      <div data-slot="card-content" className="settings-group-content">
        {children}
      </div>
    </div>
  );
}
