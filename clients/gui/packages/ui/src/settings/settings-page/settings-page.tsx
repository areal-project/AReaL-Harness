import { useId, type ReactNode } from "react";
import { cn } from "../../lib/utils.js";

/** One scroll owner and the shared centered settings column. */
export function SettingsPage({
  title,
  subtitle,
  children,
  className,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section className="settings-workspace" tabIndex={0} aria-labelledby={title ? id : undefined}>
      <div className={cn("settings-page", className)}>
        {title && (
          <header className="settings-page-header">
            <h1 id={id} className="settings-page-title">
              {title}
            </h1>
            {subtitle && <p className="settings-page-subtitle">{subtitle}</p>}
          </header>
        )}
        {children}
      </div>
    </section>
  );
}
