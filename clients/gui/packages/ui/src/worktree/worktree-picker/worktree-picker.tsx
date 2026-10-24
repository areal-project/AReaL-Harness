import { type ComponentProps, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronRight } from "lucide-react";
import { Button } from "../../components/button/button.js";
import { cn } from "../../lib/utils.js";

function Picker({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
function Row({ icon, label, value, control, className, ...props }: Omit<ComponentProps<typeof Button>, "children" | "value"> & {
  icon: ReactNode; label: ReactNode; value?: ReactNode; control?: ReactNode;
}) {
  const content = <>{icon}<span>{label}</span>{control ?? <><span className="worktree-picker-value">{value}</span><ChevronRight aria-hidden="true" /></>}</>;
  return control ? <div className={cn("worktree-picker-row", className)}>{content}</div>
    : <Button {...props} variant="ghost" className={cn("worktree-picker-row", className)}>{content}</Button>;
}
function Page({ label, backLabel, onBack, search, note, children }: {
  label: ReactNode; backLabel: string; onBack: () => void; search?: ReactNode; note?: ReactNode; children: ReactNode;
}) {
  return <><Button variant="ghost" className="worktree-picker-back" aria-label={backLabel} onClick={onBack}><ArrowLeft aria-hidden="true" /><span>{label}</span></Button>
    {search}{note && <p className="worktree-picker-note">{note}</p>}{children}</>;
}
function Options({ label, items, onSelect, disabled = false, heading, empty }: {
  label: string; items: readonly { id: string; label: string; title?: string; icon?: ReactNode; selected: boolean }[];
  onSelect: (id: string) => void; disabled?: boolean; heading?: ReactNode; empty?: ReactNode;
}) {
  const selected = items.some(item => item.selected);
  return <div className="worktree-picker-list" role="listbox" aria-label={label} onKeyDown={event => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'));
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }}>
    {!!items.length && heading && <p className="worktree-picker-group">{heading}</p>}
    {items.map((item, index) => <Button key={item.id} variant="ghost" role="option" aria-selected={item.selected} disabled={disabled}
      tabIndex={item.selected || !selected && index === 0 ? 0 : -1} className="worktree-picker-option" title={item.title ?? item.label} onClick={() => onSelect(item.id)}>
      {item.icon}<span>{item.label}</span>{item.selected && <Check aria-hidden="true" />}</Button>)}
    {!items.length && empty && <p className="worktree-picker-feedback">{empty}</p>}
  </div>;
}
export const WorktreePicker = Object.assign(Picker, { Row, Page, Options });
