import type { KeyboardEventHandler, ReactNode } from "react";
import { SettingsDisclosure } from "../../components/settings-disclosure/settings-disclosure.js";

/** Presentation only: callers retain request drafts, submission and Core reconciliation. */
export function DecisionCard({
  kind,
  label,
  icon,
  headerActions,
  children,
  details,
  detailsLabel = "查看完整请求",
  detailsExpandLabel = "展开",
  detailsCollapseLabel = "收起",
  footer,
  feedback,
  regionLabel,
  busy,
  onKeyDown,
  className = "",
}: {
  kind: string;
  label: string;
  icon: ReactNode;
  headerActions?: ReactNode;
  children: ReactNode;
  details?: ReactNode;
  detailsLabel?: string;
  detailsExpandLabel?: string;
  detailsCollapseLabel?: string;
  footer: ReactNode;
  feedback?: ReactNode;
  regionLabel: string;
  busy?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  className?: string;
}) {
  return (
    <section
      className={`decision-card ${className}`}
      data-interaction={kind}
      tabIndex={onKeyDown ? 0 : undefined}
      onKeyDown={onKeyDown}
      aria-label={regionLabel}
      aria-busy={busy}
    >
      <header className="decision-card-header">
        <span className="decision-card-label">
          {icon}
          {label}
        </span>
        <div className="decision-card-header-actions">{headerActions}</div>
      </header>
      <div className="decision-card-body">
        {children}
        {details && (
          <SettingsDisclosure
            className="decision-card-details"
            title={detailsLabel}
            expandLabel={detailsExpandLabel}
            collapseLabel={detailsCollapseLabel}
          >
            {details}
          </SettingsDisclosure>
        )}
      </div>
      {feedback}
      <footer className="decision-card-footer">{footer}</footer>
    </section>
  );
}
