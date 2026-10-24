import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("settings-section", className)}>
      {(title || action || description) && (
        <div className="settings-section-heading">
          <div className="min-w-0">
            {title && <h2 className="settings-section-title">{title}</h2>}
            {description && <p className="settings-section-desc">{description}</p>}
          </div>
          {action && <div className="settings-section-action">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
