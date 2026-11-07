import { useId, type ReactNode } from "react";
import { cn } from "../../lib/utils.js";

/** One scroll owner and the shared centered settings column. */
export function SettingsPage({
  title,
  subtitle,
  children,
  className,
  width = "default",
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
  /** wide: dense editors (two-column catalogs) that need the full window. */
  width?: "default" | "wide";
}) {
  const id = useId();
  return (
    <section
      className="settings-workspace"
      data-width={width}
      tabIndex={0}
      aria-labelledby={title ? id : undefined}
    >
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
