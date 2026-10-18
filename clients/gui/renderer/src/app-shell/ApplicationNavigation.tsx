import type { ReactNode } from "react";
import { FileMenuChevronIcon, SearchIcon as Search } from "../interfaceIcons.js";
import { Button } from "../components/ui/button.js";

type ApplicationEntry = { id: string; label: string; icon: ReactNode; onSelect: () => void; disabled?: boolean };

/** Presentation only: each host supplies real navigation actions and guards. */
export function ApplicationRail({ items, activeId, footer }: { items: readonly ApplicationEntry[]; activeId: string; footer?: ReactNode }) {
  return <nav className="application-rail" aria-label="应用导航">
    {items.map(item => <Button key={item.id} variant="ghost" size="icon" className="application-rail-button"
      aria-label={item.label} title={item.label} aria-current={activeId === item.id ? "page" : undefined}
      disabled={item.disabled} onClick={item.onSelect}>{item.icon}</Button>)}
    {footer && <div className="application-rail-footer">{footer}</div>}
  </nav>;
}

export function SidebarWorkspaceHeader({ title, onSearch }: { title: string; onSearch: () => void }) {
  return <div className="sidebar-workspace-header">
    <strong>{title}</strong>
    <Button variant="ghost" size="icon" aria-label="搜索任务" title="搜索任务" onClick={onSearch}><Search /></Button>
  </div>;
}

/** Display disclosure only; the caller retains navigation and task ownership. */
export function SidebarSectionToggle({ label, ariaLabel, controls, expanded, onToggle }: {
  label: string; ariaLabel: string; controls: string; expanded: boolean; onToggle: () => void;
}) {
  return <button type="button" className="sidebar-section-toggle" title={label}
    aria-label={ariaLabel} aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
    <span>{label}</span><FileMenuChevronIcon size={14} aria-hidden="true" />
  </button>;
}
