import type { KeyboardEventHandler, ReactNode } from "react";
import { Feedback } from "./components/ui/feedback.js";
import "./DecisionCard.css";

/** Presentation only: callers retain request drafts, submission and Core reconciliation. */
export function DecisionCard({ kind, label, icon, headerActions, children, footer, error, message, busy, onKeyDown, className = "" }: {
  kind: string;
  label: string;
  icon: ReactNode;
  headerActions?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  error?: string;
  message?: string;
  busy?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  className?: string;
}) {
  return <section className={`decision-card ${className}`} data-interaction={kind}
    tabIndex={onKeyDown ? 0 : undefined} onKeyDown={onKeyDown}
    aria-label={kind === "approval" ? "工具审批" : "需要你的回答"} aria-busy={busy}>
    <header className="decision-card-header">
      <span className="decision-card-label">{icon}{label}</span>
      <div className="decision-card-header-actions">{headerActions}</div>
    </header>
    <div className="decision-card-body">{children}</div>
    <Feedback error={error} message={message} />
    <footer className="decision-card-footer">{footer}</footer>
  </section>;
}
