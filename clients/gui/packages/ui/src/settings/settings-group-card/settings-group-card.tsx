import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export function SettingsGroupCard({
  children,
  className,
  density,
}: {
  children: ReactNode;
  className?: string;
  density?: "compact";
}) {
  return (
    <div data-density={density} className={cn("settings-group-card", className)}>
      <div data-slot="card-content" className="settings-group-content">{children}</div>
    </div>
  );
}
