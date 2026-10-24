import { Fragment, type ComponentProps, type ReactNode } from "react";
import { ChevronRight, Folder, Plus } from "lucide-react";
import { Button } from "../../components/button/button.js";
import { cn } from "../../lib/utils.js";

function Settings({ view, className, ...props }: ComponentProps<"div"> & { view: string }) {
  return <div {...props} className={cn("worktrees-settings", className)} data-view={view} />;
}
function Breadcrumb({ label, items, disabled }: { label: string; disabled?: boolean; items: readonly { id: string; label: string; onSelect?: () => void }[] }) {
  return <nav className="worktrees-breadcrumb" aria-label={label}>{items.map((item, index) => <Fragment key={item.id}>
    {index > 0 && <ChevronRight aria-hidden="true" />}{item.onSelect ? <Button variant="ghost" size="sm" disabled={disabled} onClick={item.onSelect}>{item.label}</Button> : <span aria-current="page">{item.label}</span>}
  </Fragment>)}</nav>;
}
function Project({ name, root, openLabel, addLabel, disabled, onOpen, onAdd }: { name: string; root: string; openLabel: string; addLabel: string; disabled?: boolean; onOpen: () => void; onAdd: () => void }) {
  return <div className="worktrees-project-row"><Button variant="ghost" className="worktrees-project-open" disabled={disabled} aria-label={openLabel} onClick={onOpen}><Folder /><span><span>{name}</span><small>{root}</small></span></Button>
    <Button variant="ghost" size="icon" disabled={disabled} aria-label={addLabel} onClick={onAdd}><Plus /></Button></div>;
}
function Environment({ name, label, disabled, onOpen }: { name: string; label: string; disabled?: boolean; onOpen: () => void }) {
  return <Button variant="ghost" className="worktrees-environment-open" disabled={disabled} aria-label={label} onClick={onOpen}><span>{name}</span><ChevronRight /></Button>;
}
function Script({ label, description, action, hint, children }: { label: ReactNode; description?: ReactNode; action?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return <section className="worktrees-script-field"><div className="worktrees-section-heading"><h2>{label}</h2>{action}</div>
    {description && <p className="settings-section-desc">{description}</p>}{children}{hint && <p className="settings-section-desc worktrees-override-hint">{hint}</p>}
  </section>;
}
function Action({ name, summary, controls, children, editorId }: { name: string; summary?: string; controls: ReactNode; children?: ReactNode; editorId?: string }) {
  return <div className="worktrees-action-item"><div className="worktrees-action-row"><div className="worktrees-action-summary"><span>{name}</span><code>{summary}</code></div>{controls}</div>
    {children && <div id={editorId} className="worktrees-action-editor">{children}</div>}
  </div>;
}
export const WorktreeSettings = Object.assign(Settings, { Breadcrumb, Project, Environment, Script, Action });
