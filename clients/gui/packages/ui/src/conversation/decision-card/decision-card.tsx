import type { KeyboardEventHandler, ReactNode } from "react";

/** Presentation only: callers retain request drafts, submission and Core reconciliation. */
export function DecisionCard({ kind, label, icon, headerActions, children, details, detailsLabel = "查看完整请求", footer, feedback, regionLabel, busy, onKeyDown, className = "" }: {
  kind: string;
  label: string;
  icon: ReactNode;
  headerActions?: ReactNode;
  children: ReactNode;
  details?: ReactNode;
  detailsLabel?: string;
  footer: ReactNode;
  feedback?: ReactNode;
  regionLabel: string;
  busy?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  className?: string;
}) {
  return <section className={`decision-card ${className}`} data-interaction={kind}
    tabIndex={onKeyDown ? 0 : undefined} onKeyDown={onKeyDown}
    aria-label={regionLabel} aria-busy={busy}>
    <header className="decision-card-header">
      <span className="decision-card-label">{icon}{label}</span>
      <div className="decision-card-header-actions">{headerActions}</div>
    </header>
    <div className="decision-card-body">{children}{details && <details className="decision-card-details"><summary>{detailsLabel}</summary><div>{details}</div></details>}</div>
    {feedback}
    <footer className="decision-card-footer">{footer}</footer>
  </section>;
}
